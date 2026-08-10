import { createHash } from "node:crypto";
import {
  type AgentProfile,
  type AgentSession,
  type AgentSpec,
  type AnyWorkerSpecVersion,
  type CollaborationChange,
  type ChangeSet,
  type ControlCommand,
  type ConversationBlock,
  type DesignSession,
  EvidenceSchema,
  type FlowDefinition,
  type FlowRun,
  type HarnessIntent,
  type ProductionProposal,
  type StewardCommandDraft,
  type WorkerProfile,
  type WorkerSession,
  WeaveDiffSchema,
  assertWorkTransition,
  classifyDiff,
  type EventEnvelope,
  type ExecutionContract,
  type GraphNode,
  type WeaveOperation,
} from "@mycel/domain";
import { ulid } from "ulid";
import type {
  EventStorePort,
  ClockPort,
  ExecutorPort,
  NotifierPort,
  StewardPort,
  StewardControlPlanePort,
  WorkNode,
} from "./ports.js";
import { NoopNotifier, systemClock } from "./ports.js";
import type { AppProjection, MutationView, RunView, StewardResponseView } from "./projection.js";
import { compileProductionPlan, proposalId, validateProductionPlan } from "./production-plan.js";

export interface ApplicationConfig {
  repositoryId: string;
  executorActorId: string;
  ownerActorId: string;
  stewardActorId: string;
  testCommandId: string;
  testCommandArgv: string[];
  initialGraphOperations?: WeaveOperation[];
}

export interface SubmitIntentInput {
  messageId: string;
  channel: "dingtalk" | "feishu" | "web";
  conversationId: string;
  actorId: string;
  text: string;
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
  timezone?: string;
  onProgress?: (phase: "preparing-workspace" | "invoking-steward" | "inspecting-resources" | "validating-result" | "composing-response") => void | Promise<void>;
}

export type SubmitIntentResult =
  | { kind: "answer"; response: StewardResponseView; replayed: boolean }
  | { kind: "clarification"; response: StewardResponseView; replayed: boolean }
  | { kind: "resource" | "command"; block: ConversationBlock; replayed: boolean }
  | { kind: "proposal"; proposal: ProductionProposal; block: ConversationBlock; replayed: boolean }
  | { kind: "changeset"; changeSet: ChangeSet; block: ConversationBlock; replayed: boolean }
  | { kind: "weave_diff"; mutation: MutationView; replayed: boolean };

export class ApplicationService {
  readonly #store: EventStorePort;
  readonly #steward: StewardPort;
  readonly #executor: ExecutorPort;
  readonly #notifier: NotifierPort;
  readonly #clock: ClockPort;
  readonly #config: ApplicationConfig;
  readonly #activeRuns = new Map<string, Promise<void>>();
  #stewardControl?: StewardControlPlanePort;

  constructor(
    store: EventStorePort,
    steward: StewardPort,
    executor: ExecutorPort,
    config: ApplicationConfig,
    notifier: NotifierPort = new NoopNotifier(),
    clock: ClockPort = systemClock,
  ) {
    this.#store = store;
    this.#steward = steward;
    this.#executor = executor;
    this.#config = config;
    this.#notifier = notifier;
    this.#clock = clock;
  }

  async initialize(): Promise<void> {
    if (this.#store.getProjection().graph.version > 0) return;
    const now = this.#now();
    const operations = this.#config.initialGraphOperations ?? seedOperations(this.#config, now);
    this.#append({
      eventType: "GraphMutation",
      aggregateType: "graph",
      aggregateId: "graph:main",
      actorId: "system",
      correlationId: "bootstrap",
      causationId: null,
      idempotencyKey: "bootstrap:graph:v1",
      payload: {
        phase: "applied",
        mutationId: "bootstrap",
        operations,
        appliedOperationIds: operations.map((operation) => operation.operationId),
        pendingOperationIds: [],
        rejectedOperationIds: [],
      },
    });
  }

  getProjection(): AppProjection {
    return this.#store.getProjection();
  }

  setStewardControlPlane(control: StewardControlPlanePort): void {
    this.#stewardControl = control;
  }

  readLedger(correlationId?: string): EventEnvelope[] {
    return correlationId ? this.#store.readCorrelation(correlationId) : this.#store.readAll();
  }

  recordCardDelivered(input: {
    outTrackId: string;
    aggregateId: string;
    state: string;
    cardInstanceId?: string;
    correlationId: string;
  }): AppProjection {
    const result = this.#append({
      eventType: "CardDelivered",
      aggregateType: "card",
      aggregateId: input.outTrackId,
      actorId: "channel:dingtalk",
      correlationId: input.correlationId,
      causationId: null,
      idempotencyKey: `card:${input.outTrackId}:state:${input.state}`,
      payload: {
        outTrackId: input.outTrackId,
        aggregateId: input.aggregateId,
        state: input.state,
        ...(input.cardInstanceId !== undefined ? { cardInstanceId: input.cardInstanceId } : {}),
      },
    });
    return result.projection;
  }

  recordCardCallback(input: {
    messageId: string;
    outTrackId: string;
    action: string;
    actorId: string;
    raw: unknown;
  }): { inserted: boolean; projection: AppProjection } {
    const result = this.#append({
      eventType: "CardCallbackReceived",
      aggregateType: "card",
      aggregateId: input.outTrackId,
      actorId: input.actorId,
      correlationId: `card:${input.outTrackId}`,
      causationId: null,
      idempotencyKey: `dingtalk:card-callback:${input.messageId}`,
      payload: input,
    });
    return { inserted: result.inserted, projection: result.projection };
  }

  async submitIntent(input: SubmitIntentInput): Promise<SubmitIntentResult> {
    const correlationId = `corr_${ulid()}`;
    const received = this.#append({
      eventType: "ChannelMessageReceived",
      aggregateType: "channel",
      aggregateId: input.conversationId,
      actorId: input.actorId,
      correlationId,
      causationId: null,
      idempotencyKey: `message:${input.channel}:${input.messageId}`,
      payload: {
        id: input.messageId,
        channel: input.channel,
        conversationId: input.conversationId,
        actorId: input.actorId,
        text: input.text,
      },
    });
    if (!received.inserted) {
      const block = (received.projection.conversationBlocks ?? []).find((candidate) => candidate.sourceMessageId === input.messageId);
      if (block?.changeSetId) return { kind: "changeset", changeSet: requiredChangeSet(received.projection, block.changeSetId), block, replayed: true };
      if (block?.proposalId) return { kind: "proposal", proposal: requiredProposal(received.projection, block.proposalId), block, replayed: true };
      if (block?.kind === "resource" || block?.kind === "command") return { kind: block.kind, block, replayed: true };
      const response = (received.projection.stewardResponses ?? []).find(
        (candidate) => candidate.sourceMessageId === input.messageId,
      );
      if (response) return { kind: response.kind, response, replayed: true };
      const existing = Object.values(received.projection.mutations).find(
        (mutation) => mutation.diff.sourceMessageId === input.messageId,
      );
      if (!existing) throw new Error("duplicate message is still being processed");
      return { kind: "weave_diff", mutation: existing, replayed: true };
    }

    const projection = received.projection;
    await input.onProgress?.("preparing-workspace");
    const activeDesignSession = latestDesignSession(projection, input.conversationId);
    const planInput = {
      text: input.text,
      sourceMessageId: input.messageId,
      originatorActorId: input.actorId,
      graph: projection.graph,
      repositoryId: this.#config.repositoryId,
      workspaceId: input.workspaceId ?? "repository",
      workspaceName: input.workspaceName ?? input.workspaceId ?? "repository",
      workspacePath: input.workspacePath ?? this.#config.repositoryId,
      localTimezone: input.timezone ?? systemTimezone(),
      executorActorId: this.#config.executorActorId,
      testCommandId: this.#config.testCommandId,
      history: conversationHistory(projection, input.conversationId, input.messageId),
      ...(activeDesignSession ? { designSession: activeDesignSession } : {}),
      resources: {
        actors: projection.graph.nodes.filter((node) => node.type === "actor").map((node) => ({ id: node.id, name: node.name, kind: node.kind })),
        flows: Object.values(projection.flows ?? {}).map((flow) => ({ id: flow.id, name: flow.name, status: flow.status })),
        runs: Object.values(projection.flowRuns ?? {}).map((run) => ({ id: run.id, flowId: run.flowId, phase: run.phase })),
        workspaces: [{ id: input.workspaceId ?? "repository", name: input.workspaceName ?? input.workspaceId ?? this.#config.repositoryId }],
        workers: Object.values(projection.workers ?? {}).map((worker) => ({ id: worker.id, name: worker.name, source: worker.source, status: worker.status, ...(worker.defaultSpecVersionId ? { defaultSpecVersionId: worker.defaultSpecVersionId } : {}) })),
        tasks: Object.values(projection.tasks ?? {}).map((task) => ({ id: task.id, title: task.title, status: task.status, version: task.version, ...(task.currentAttemptId ? { currentAttemptId: task.currentAttemptId } : {}) })),
        sessions: Object.values(projection.workerSessions ?? {}).map((session) => ({ id: session.id, workerId: session.workerId, phase: session.phase, ...(session.taskId ? { taskId: session.taskId } : {}) })),
        workerSpecs: Object.values(projection.workerSpecs ?? {}).map((spec) => ({ id: spec.id, workerId: spec.workerId, version: spec.version })),
      },
    };
    await input.onProgress?.("invoking-steward");
    let decision = await this.#steward.respond(planInput, (phase) => input.onProgress?.(phase));
    await input.onProgress?.("validating-result");
    await input.onProgress?.("composing-response");

    if (decision.kind === "answer" || decision.kind === "clarification") {
      if (decision.kind === "clarification" && "design" in decision && decision.design) this.#recordDesignSession({
        id: latestDesignSession(projection, input.conversationId)?.id ?? `design_${ulid()}`,
        conversationId: input.conversationId,
        sourceMessageId: input.messageId,
        status: "clarifying",
        summary: decision.design.summary,
        decisions: decision.design.decisions,
        openQuestion: decision.design.openQuestion,
        createdAt: latestDesignSession(projection, input.conversationId)?.createdAt ?? this.#now(),
        updatedAt: this.#now(),
      }, correlationId, received.event.eventId);
      const responseId = `resp_${ulid()}`;
      const produced = this.#append({
        eventType: "StewardResponseProduced",
        aggregateType: "channel",
        aggregateId: input.conversationId,
        actorId: this.#config.stewardActorId,
        correlationId,
        causationId: received.event.eventId,
        idempotencyKey: `response:${input.channel}:${input.messageId}`,
        payload: {
          id: responseId,
          sourceMessageId: input.messageId,
          conversationId: input.conversationId,
          kind: decision.kind,
          text: decision.text,
          reasoningSummary: decision.reasoningSummary,
        },
      });
      this.#recordConversationBlock({
        id: `block_${ulid()}`, conversationId: input.conversationId, sourceMessageId: input.messageId,
        kind: decision.kind, text: decision.text, status: "active", createdAt: this.#now(), updatedAt: this.#now(),
      }, correlationId, produced.event.eventId);
      return {
        kind: decision.kind,
        response: requiredStewardResponse(produced.projection, responseId),
        replayed: false,
      };
    }

    if (decision.kind === "resource") {
      const now = this.#now();
      const block: ConversationBlock = {
        id: `block_${ulid()}`, conversationId: input.conversationId, sourceMessageId: input.messageId,
        kind: "resource", text: decision.text, status: "active", resource: decision.resource,
        createdAt: now, updatedAt: now,
      };
      this.#recordConversationBlock(block, correlationId, received.event.eventId);
      return { kind: "resource", block, replayed: false };
    }

    if (decision.kind === "command" && !isStewardCommandDraft(decision.command)) {
      const now = this.#now();
      const block: ConversationBlock = { id: `block_${ulid()}`, conversationId: input.conversationId, sourceMessageId: input.messageId, kind: "command", text: decision.text, status: "active", command: decision.command, createdAt: now, updatedAt: now };
      this.#recordConversationBlock(block, correlationId, received.event.eventId);
      return { kind: "command", block, replayed: false };
    }

    if (decision.kind === "command" && isStewardCommandDraft(decision.command)) {
      if (!this.#stewardControl) throw new Error("Steward Control Plane is not configured");
      const now = this.#now();
      const command: ControlCommand = {
        schemaVersion: 1, id: `command_${ulid()}`, action: decision.command.action, target: decision.command.target,
        arguments: decision.command.arguments, ...(decision.command.expectedVersion !== undefined ? { expectedVersion: decision.command.expectedVersion } : {}),
        contextVersion: projection.graph.version, initiatedBy: input.actorId, sourceMessageId: input.messageId,
        idempotencyKey: `steward-command:${input.channel}:${input.messageId}`, status: "planned", createdAt: now, updatedAt: now,
      };
      const executed = await this.#stewardControl.executeCommand(command);
      const block: ConversationBlock = { id: `block_${ulid()}`, conversationId: input.conversationId, sourceMessageId: input.messageId, kind: "command", text: executed.status === "succeeded" ? decision.text : `${decision.text}\n\n未完成：${executed.error ?? "命令执行失败"}`, status: executed.status === "succeeded" ? "resolved" : "failed", command: executed, createdAt: now, updatedAt: this.#now() };
      this.#recordConversationBlock(block, correlationId, received.event.eventId);
      return { kind: "command", block, replayed: false };
    }

    if (decision.kind === "changeset") {
      if (!this.#stewardControl) throw new Error("Steward Control Plane is not configured");
      const now = this.#now();
      const draft: ChangeSet = {
        schemaVersion: 1, id: `changeset_${ulid()}`, title: decision.changeSet.title, intentSummary: decision.changeSet.intentSummary,
        operations: decision.changeSet.operations, preconditions: decision.changeSet.preconditions,
        impact: { resourcesCreated: [], resourcesModified: [], resourcesArchived: [], permissionsAdded: [], runtimeEffects: [], warnings: [] },
        aggregateRisk: "green", status: "draft", operationResults: [], contextVersion: projection.graph.version,
        initiatedBy: input.actorId, sourceMessageId: input.messageId, idempotencyKey: `steward-changeset:${input.channel}:${input.messageId}`, createdAt: now, updatedAt: now,
      };
      const changeSet = await this.#stewardControl.proposeChangeSet(draft);
      const block: ConversationBlock = { id: `block_${ulid()}`, conversationId: input.conversationId, sourceMessageId: input.messageId, kind: "changeset", title: changeSet.title, text: decision.text, status: "active", changeSetId: changeSet.id, createdAt: now, updatedAt: now };
      this.#recordConversationBlock(block, correlationId, received.event.eventId);
      return { kind: "changeset", changeSet, block, replayed: false };
    }

    if (decision.kind === "proposal") {
      let diagnostics = validateProductionPlan(decision.plan, {
        actorIds: new Set(projection.graph.nodes.filter((node) => node.type === "actor").map((node) => node.id)),
        workspaceIds: new Set([input.workspaceId ?? "repository"]),
      });
      if (diagnostics.length > 0 && this.#steward.repair) {
        const repaired = await this.#steward.repair(planInput, diagnostics, decision, (phase) => input.onProgress?.(phase));
        if (repaired.kind === "proposal") {
          decision = repaired;
          diagnostics = validateProductionPlan(repaired.plan, {
            actorIds: new Set(projection.graph.nodes.filter((node) => node.type === "actor").map((node) => node.id)),
            workspaceIds: new Set([input.workspaceId ?? "repository"]),
          });
        }
      }
      if (decision.kind !== "proposal" || diagnostics.length > 0) {
        const text = "这个生产图还不能安全部署。我需要先确认：" + diagnostics.map((item) => item.message).join("；");
        return this.#recordClarification(input, correlationId, received.event.eventId, text, "ProductionPlan validation failed after one repair attempt", diagnostics);
      }
      const id = proposalId();
      const compiled = compileProductionPlan(decision.plan, id);
      const now = this.#now();
      const proposal: ProductionProposal = {
        id, conversationId: input.conversationId, sourceMessageId: input.messageId,
        ...(latestDesignSession(projection, input.conversationId) ? { designSessionId: latestDesignSession(projection, input.conversationId)!.id } : {}),
        status: "ready", plan: decision.plan, compiledFlowId: compiled.flow.id, diagnostics: [], createdAt: now, updatedAt: now,
      };
      this.#recordProposal(proposal, correlationId, received.event.eventId);
      const block: ConversationBlock = { id: `block_${ulid()}`, conversationId: input.conversationId, sourceMessageId: input.messageId, kind: "proposal", title: decision.plan.title, text: decision.text, status: "active", proposalId: id, createdAt: now, updatedAt: now };
      this.#recordConversationBlock(block, correlationId, received.event.eventId);
      await this.#notifier.proposalChanged(proposal, this.#store.getProjection());
      return { kind: "proposal", proposal, block, replayed: false };
    }

    if (decision.kind === "weave_diff") {
      const diff = WeaveDiffSchema.parse({ ...decision.diff, id: `mut_${ulid()}`, baseGraphVersion: projection.graph.version, originatorActorId: input.actorId, sourceMessageId: input.messageId });
      const risk = classifyDiff(diff);
      const autoOperations = diff.operations.filter((operation) => risk.operations[operation.operationId] !== "red");
      const pendingOperationIds = diff.operations.filter((operation) => risk.operations[operation.operationId] === "red").map((operation) => operation.operationId);
      const proposed = this.#append({ eventType: "GraphMutation", aggregateType: "mutation", aggregateId: diff.id, actorId: this.#config.stewardActorId, correlationId, causationId: received.event.eventId, idempotencyKey: `mutation:${diff.id}:proposed`, payload: { phase: "proposed", mutationId: diff.id, diff, aggregateRisk: risk.aggregate, operationRisks: risk.operations, pendingOperationIds: diff.operations.map((operation) => operation.operationId) } });
      let latestProjection = proposed.projection;
      if (autoOperations.length > 0) latestProjection = this.#append({ eventType: "GraphMutation", aggregateType: "mutation", aggregateId: diff.id, actorId: "system:risk-engine", correlationId, causationId: proposed.event.eventId, idempotencyKey: `mutation:${diff.id}:auto-applied`, payload: { phase: "applied", mutationId: diff.id, operations: autoOperations, appliedOperationIds: autoOperations.map((operation) => operation.operationId), pendingOperationIds, rejectedOperationIds: [] } }).projection;
      const mutation = requiredMutation(latestProjection, diff.id);
      await this.#notifier.mutationChanged(mutation, latestProjection);
      if (pendingOperationIds.length === 0) { this.#materializeGraphNativeAgents(diff.operations); await this.#dispatchMutation(mutation); }
      return { kind: "weave_diff", mutation, replayed: false };
    }
    throw new Error("Steward returned an unsupported intent kind");
  }

  recordAgentProfile(profile: AgentProfile, spec?: AgentSpec): AppProjection {
    const projection = this.#store.getProjection();
    const operations: WeaveOperation[] = [];
    const actor = projection.graph.nodes.find((node) => node.id === profile.id);
    const actorInput: GraphNode = {
      id: profile.id,
      name: profile.name,
      type: "actor",
      kind: "agent",
      runtime: profile.adapterKind,
      status: profile.status,
      source: profile.source,
      adapterKind: profile.adapterKind,
      lifecycle: profile.lifecycle,
      ...(profile.specVersionId ? { specVersionId: profile.specVersionId } : {}),
      ...(profile.subgraphId ? { subgraphId: profile.subgraphId } : {}),
      createdAt: actor?.createdAt ?? profile.registeredAt,
      updatedAt: profile.updatedAt,
    };
    operations.push(actor
      ? { operationId: `update-${safeOperationId(profile.id)}`, op: "update_node", explanation: "Refresh registered Agent runtime", nodeId: profile.id, patch: actorInput }
      : { operationId: `add-${safeOperationId(profile.id)}`, op: "add_node", explanation: "Register Agent Actor", node: actorInput });

    const capabilityId = runtimeCapabilityId(profile.adapterKind);
    if (!projection.graph.nodes.some((node) => node.id === capabilityId)) {
      operations.push({
        operationId: `add-${safeOperationId(capabilityId)}`,
        op: "add_node",
        explanation: "Register Agent runtime capability",
        node: {
          id: capabilityId,
          name: `${profile.adapterKind} runtime`,
          type: "capability",
          kind: profile.adapterKind === "claude-code" ? "claude-code" : profile.adapterKind === "codex" ? "codex" : "agent-runtime",
          scope: "local",
          constraints: { adapterKind: profile.adapterKind },
          createdAt: profile.registeredAt,
          updatedAt: profile.updatedAt,
        },
      });
    }
    const equipEdgeId = `edge:equip:${profile.id}:${capabilityId}`;
    if (!projection.graph.edges.some((edge) => edge.id === equipEdgeId)) {
      operations.push({ operationId: `add-${safeOperationId(equipEdgeId)}`, op: "add_edge", explanation: "Equip Agent runtime", edge: { id: equipEdgeId, type: "equipped_with", from: profile.id, to: capabilityId } });
    }

    if (spec && !projection.graph.nodes.some((node) => node.id === spec.id)) {
      operations.push({
        operationId: `add-${safeOperationId(spec.id)}`,
        op: "add_node",
        explanation: "Publish AgentSpec version",
        node: {
          id: spec.id,
          name: `${profile.name} spec v${spec.version}`,
          type: "artifact",
          kind: "agent-spec",
          uri: `mycel://agent-spec/${encodeURIComponent(spec.id)}`,
          sha256: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
          mediaType: "application/vnd.mycel.agent-spec+json",
          summary: spec.prompt.slice(0, 240),
          createdAt: spec.createdAt,
          updatedAt: spec.createdAt,
        },
      });
      operations.push({
        operationId: `configure-${safeOperationId(profile.id)}-${spec.version}`,
        op: "add_edge",
        explanation: "Bind Agent to an exact AgentSpec version",
        edge: { id: `edge:configured:${profile.id}:${spec.id}`, type: "configured_by", from: profile.id, to: spec.id },
      });
    }
    if (operations.length > 0) this.#applySystemGraphOperations(operations, `agent-graph:${profile.id}:${profile.updatedAt}`, profile.source === "graph-native" ? this.#config.stewardActorId : "system:agent-registry");

    return this.#append({
      eventType: "AgentRuntimeEvent",
      aggregateType: "system",
      aggregateId: profile.id,
      actorId: profile.source === "graph-native" ? this.#config.stewardActorId : "system:agent-registry",
      correlationId: `agent:${profile.id}`,
      causationId: null,
      idempotencyKey: `agent-profile:${profile.id}:${profile.updatedAt}`,
      payload: { profile, ...(spec ? { spec } : {}) },
    }).projection;
  }

  recordAgentSession(session: AgentSession): AppProjection {
    return this.#append({
      eventType: "AgentSessionEvent",
      aggregateType: "run",
      aggregateId: session.id,
      actorId: session.agentId,
      correlationId: session.flowRunId ? `flow-run:${session.flowRunId}` : `agent-session:${session.id}`,
      causationId: null,
      idempotencyKey: `agent-session:${session.id}:${session.updatedAt}:${session.phase}:${createHash("sha256").update(session.lastEvent).digest("hex").slice(0, 12)}`,
      payload: { session },
    }).projection;
  }

  recordWorkerProfile(profile: WorkerProfile, spec?: AnyWorkerSpecVersion): AppProjection {
    const projection = this.#store.getProjection();
    const existing = projection.graph.nodes.find((node) => node.id === profile.id);
    const operations: WeaveOperation[] = [existing
      ? { operationId: `update-${safeOperationId(profile.id)}`, op: "update_node", explanation: "Update Worker runtime", nodeId: profile.id, patch: { name: profile.name, status: profile.status, source: profile.source === "native" ? "graph-native" : "adopted", adapterKind: profile.adapterKind, lifecycle: profile.lifecycle, ...(profile.defaultSpecVersionId ? { specVersionId: profile.defaultSpecVersionId } : {}) } }
      : { operationId: `add-${safeOperationId(profile.id)}`, op: "add_node", explanation: "Register Worker runtime", node: { id: profile.id, name: profile.name, type: "actor", kind: "agent", status: profile.status, source: profile.source === "native" ? "graph-native" : "adopted", adapterKind: profile.adapterKind, lifecycle: profile.lifecycle, ...(profile.defaultSpecVersionId ? { specVersionId: profile.defaultSpecVersionId } : {}), createdAt: profile.registeredAt, updatedAt: profile.updatedAt } }];
    if (spec && !projection.graph.nodes.some((node) => node.id === spec.id)) {
      operations.push({
        operationId: `add-${safeOperationId(spec.id)}`,
        op: "add_node",
        explanation: "Publish immutable WorkerSpec version",
        node: {
          id: spec.id,
          name: `${profile.name} spec v${spec.version}`,
          type: "artifact",
          kind: "agent-spec",
          uri: `mycel://worker-spec/${encodeURIComponent(spec.id)}`,
          sha256: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
          mediaType: "application/vnd.mycel.worker-spec+json",
          summary: spec.systemPrompt.slice(0, 240),
          createdAt: spec.createdAt,
          updatedAt: spec.createdAt,
        },
      });
      operations.push({
        operationId: `configure-${safeOperationId(profile.id)}-${spec.version}`,
        op: "add_edge",
        explanation: "Bind Worker to an exact WorkerSpec version",
        edge: { id: `edge:configured:${profile.id}:${spec.id}`, type: "configured_by", from: profile.id, to: spec.id },
      });
    }
    if (operations.length) this.#applySystemGraphOperations(operations, `worker-graph:${profile.id}:${profile.updatedAt}`, profile.source === "native" ? this.#config.stewardActorId : "system:worker-registry");
    return this.#append({
      eventType: "WorkerRuntimeEvent", aggregateType: "system", aggregateId: profile.id,
      actorId: profile.source === "native" ? this.#config.stewardActorId : "system:worker-registry",
      correlationId: `worker:${profile.id}`, causationId: null,
      idempotencyKey: `worker-profile:${profile.id}:${profile.updatedAt}`,
      payload: { profile, ...(spec ? { spec } : {}) },
    }).projection;
  }

  recordWorkerSpec(spec: AnyWorkerSpecVersion, actorId = this.#config.stewardActorId): AppProjection {
    const existing = this.#store.getProjection().workerSpecs[spec.id];
    if (existing && JSON.stringify(existing) !== JSON.stringify(spec)) throw new Error(`WorkerSpecVersion is immutable: ${spec.id}`);
    return this.#append({
      eventType: "WorkerSpecEvent", aggregateType: "system", aggregateId: spec.id, actorId,
      correlationId: `worker:${spec.workerId}`, causationId: null,
      idempotencyKey: `worker-spec:${spec.id}:${createHash("sha256").update(JSON.stringify(spec)).digest("hex")}`,
      payload: { spec },
    }).projection;
  }

  recordWorkerSession(session: WorkerSession): AppProjection {
    return this.#append({
      eventType: "WorkerSessionEvent", aggregateType: "run", aggregateId: session.id, actorId: session.workerId,
      correlationId: session.flowRunId ? `flow-run:${session.flowRunId}` : session.taskId ? `task:${session.taskId}` : `worker-session:${session.id}`,
      causationId: null,
      idempotencyKey: `worker-session:${session.id}:${session.updatedAt}:${session.phase}:${createHash("sha256").update(session.lastEvent).digest("hex").slice(0, 12)}`,
      payload: { session },
    }).projection;
  }

  applyControlGraphOperations(operations: WeaveOperation[], idempotencyKey: string, actorId: string): AppProjection {
    return this.#applySystemGraphOperations(operations, idempotencyKey, actorId);
  }

  recordFlowDefinition(flow: FlowDefinition): AppProjection {
    const projection = this.#store.getProjection();
    const flowWorkId = `work:flow:${flow.id}`;
    const existing = projection.graph.nodes.find((node) => node.id === flowWorkId);
    const work: GraphNode = {
      id: flowWorkId,
      name: flow.name,
      type: "work",
      kind: "flow",
      workType: "execute",
      subgraphId: `flow:${flow.id}`,
      description: flow.description,
      status: flow.status === "published" ? "approved" : flow.status === "retired" ? "completed" : "proposed",
      acceptanceCriteria: ["Each run satisfies the published FlowVersion"],
      risk: "yellow",
      createdAt: existing?.createdAt ?? flow.createdAt,
      updatedAt: flow.updatedAt,
    };
    const operations: WeaveOperation[] = [existing
      ? { operationId: `update-${safeOperationId(flowWorkId)}`, op: "update_node", explanation: "Update Flow Work", nodeId: flowWorkId, patch: work }
      : { operationId: `add-${safeOperationId(flowWorkId)}`, op: "add_node", explanation: "Create Flow Work", node: work }];
    if (flow.status === "published") {
      const versionId = `artifact:flow:${flow.id}:v${flow.version}`;
      if (!projection.graph.nodes.some((node) => node.id === versionId)) {
        operations.push({
          operationId: `add-${safeOperationId(versionId)}`,
          op: "add_node",
          explanation: "Publish immutable FlowVersion",
          node: {
            id: versionId,
            name: `${flow.name} v${flow.version}`,
            type: "artifact",
            kind: "flow-version",
            uri: `mycel://flow/${encodeURIComponent(flow.id)}/versions/${flow.version}`,
            sha256: createHash("sha256").update(JSON.stringify(flow)).digest("hex"),
            mediaType: "application/vnd.mycel.flow+json",
            summary: `${flow.steps.length} steps · ${flow.trigger.kind}`,
            subgraphId: `flow:${flow.id}`,
            createdAt: flow.updatedAt,
            updatedAt: flow.updatedAt,
          },
        });
        operations.push({ operationId: `reference-${flow.version}`, op: "add_edge", explanation: "Point Flow to published version", edge: { id: `edge:flow-version:${flow.id}:${flow.version}`, type: "references", from: flowWorkId, to: versionId, subgraphId: `flow:${flow.id}` } });
        for (const step of flow.steps) {
          const stepId = `work:flow:${flow.id}:v${flow.version}:${step.id}`;
          operations.push({
            operationId: `add-${safeOperationId(stepId)}`,
            op: "add_node",
            explanation: "Materialize published Flow step",
            node: {
              id: stepId,
              name: step.name,
              type: "work",
              kind: "step",
              workType: step.kind === "human" ? "approval" : "execute",
              parentWorkId: flowWorkId,
              flowVersionId: versionId,
              subgraphId: `flow:${flow.id}:v${flow.version}`,
              description: step.prompt,
              status: "proposed",
              acceptanceCriteria: ["Step completes according to its runtime contract"],
              risk: step.kind === "human" ? "red" : "yellow",
              createdAt: flow.updatedAt,
              updatedAt: flow.updatedAt,
            },
          });
          operations.push({ operationId: `contain-${safeOperationId(stepId)}`, op: "add_edge", explanation: "Add step to Flow", edge: { id: `edge:contains:${flow.id}:v${flow.version}:${step.id}`, type: "contains", from: flowWorkId, to: stepId, subgraphId: `flow:${flow.id}:v${flow.version}` } });
          if (projection.graph.nodes.some((node) => node.id === step.actorId)) {
            operations.push({ operationId: `assign-${safeOperationId(stepId)}`, op: "add_edge", explanation: "Assign Flow step", edge: { id: `edge:flow-assignment:${flow.id}:v${flow.version}:${step.id}`, type: "assignment", from: step.actorId, to: stepId, role: "executor", subgraphId: `flow:${flow.id}:v${flow.version}` } });
          }
        }
        for (const step of flow.steps) for (const dependency of step.dependsOn) {
          operations.push({
            operationId: `depend-${safeOperationId(step.id)}-${safeOperationId(dependency)}`,
            op: "add_edge",
            explanation: "Materialize Flow dependency",
            edge: {
              id: `edge:flow-dependency:${flow.id}:v${flow.version}:${step.id}:${dependency}`,
              type: "depends_on",
              from: `work:flow:${flow.id}:v${flow.version}:${step.id}`,
              to: `work:flow:${flow.id}:v${flow.version}:${dependency}`,
              condition: step.condition,
              subgraphId: `flow:${flow.id}:v${flow.version}`,
            },
          });
        }
      }
    }
    this.#applySystemGraphOperations(operations, `flow-graph:${flow.id}:${flow.version}:${flow.updatedAt}`, this.#config.stewardActorId);
    return this.#append({
      eventType: "FlowDefinitionEvent",
      aggregateType: "work",
      aggregateId: flow.id,
      actorId: this.#config.stewardActorId,
      correlationId: `flow:${flow.id}`,
      causationId: null,
      idempotencyKey: `flow-definition:${flow.id}:${flow.version}:${flow.updatedAt}`,
      payload: { flow },
    }).projection;
  }

  recordFlowRun(run: FlowRun, message: string): AppProjection {
    const projection = this.#store.getProjection();
    const existingRunNode = projection.graph.nodes.find((node) => node.id === run.id);
    if (!existingRunNode) {
      const versionId = `artifact:flow:${run.flowId}:v${run.flowVersion}`;
      const operations: WeaveOperation[] = [{
        operationId: `add-${safeOperationId(run.id)}`,
        op: "add_node",
        explanation: "Create Flow Run subgraph",
        node: {
          id: run.id,
          name: `${projection.flows?.[run.flowId]?.name ?? run.flowId} run`,
          type: "work",
          kind: "run",
          workType: "execute",
          flowVersionId: versionId,
          subgraphId: `run:${run.id}`,
          description: message,
          status: "approved",
          acceptanceCriteria: ["All required Flow steps complete"],
          risk: "yellow",
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        },
      }];
      if (projection.graph.nodes.some((node) => node.id === versionId)) operations.push({ operationId: `instantiate-${safeOperationId(run.id)}`, op: "add_edge", explanation: "Bind Run to FlowVersion", edge: { id: `edge:instantiates:${run.id}`, type: "instantiates", from: run.id, to: versionId, subgraphId: `run:${run.id}` } });
      this.#applySystemGraphOperations(operations, `flow-run-graph:${run.id}`, "system:flow-engine");
    } else {
      const status = run.phase === "completed" ? "completed" : run.phase === "failed" ? "failed" : run.phase === "canceled" ? "canceled" : run.phase === "running" ? "running" : "approved";
      this.#applySystemGraphOperations([{
        operationId: `update-${safeOperationId(run.id)}-${safeOperationId(run.phase)}`,
        op: "update_node",
        explanation: "Update Flow Run state",
        nodeId: run.id,
        patch: { status, description: message },
      }], `flow-run-graph:${run.id}:${run.updatedAt}:${run.phase}`, "system:flow-engine");
    }
    return this.#append({
      eventType: "FlowRuntimeEvent",
      aggregateType: "run",
      aggregateId: run.id,
      actorId: "system:flow-engine",
      correlationId: `flow-run:${run.id}`,
      causationId: null,
      idempotencyKey: `flow-run:${run.id}:${run.updatedAt}:${run.phase}:${message}`,
      payload: { run, message },
    }).projection;
  }

  recordCollaboration(change: CollaborationChange, message: string, idempotencyKey: string): AppProjection {
    const projection = this.#store.getProjection();
    const flowRunId = collaborationRunId(change, projection);
    this.#materializeCollaborationGraph(change, message);
    return this.#append({
      eventType: "CollaborationRuntimeEvent",
      aggregateType: "run",
      aggregateId: flowRunId,
      actorId: collaborationActorId(change),
      correlationId: `flow-run:${flowRunId}`,
      causationId: null,
      idempotencyKey: `collaboration:${idempotencyKey}`,
      payload: { change, message },
    }).projection;
  }

  createHumanActor(input: { id: string; name: string; dingtalkUserId?: string }): AppProjection {
    const now = this.#now();
    const operation: WeaveOperation = {
      operationId: `add-${safeOperationId(input.id)}`,
      op: "add_node",
      explanation: "Register Human Actor",
      node: { id: input.id, name: input.name, type: "actor", kind: "human", source: "human", status: "online", ...(input.dingtalkUserId ? { dingtalkUserId: input.dingtalkUserId } : {}), createdAt: now, updatedAt: now },
    };
    return this.#applySystemGraphOperations([operation], `human-actor:${input.id}`, this.#config.ownerActorId);
  }

  compileProposal(proposalIdValue: string) {
    const proposal = requiredProposal(this.#store.getProjection(), proposalIdValue);
    if (proposal.status !== "ready" && proposal.status !== "approved") throw new Error(`proposal cannot be compiled from ${proposal.status}`);
    return compileProductionPlan(proposal.plan, proposal.id);
  }

  recordCompiledAgents(proposalIdValue: string): void {
    const compiled = this.compileProposal(proposalIdValue);
    for (const agent of compiled.agents) this.recordAgentProfile(agent.profile, agent.spec);
  }

  updateProposalStatus(proposalIdValue: string, status: ProductionProposal["status"], message?: string): ProductionProposal {
    const current = requiredProposal(this.#store.getProjection(), proposalIdValue);
    const now = this.#now();
    const proposal: ProductionProposal = { ...current, status, updatedAt: now };
    this.#recordProposal(proposal, `proposal:${proposal.id}`, null);
    const block = this.#store.getProjection().conversationBlocks.find((candidate) => candidate.proposalId === proposal.id);
    if (block) this.#recordConversationBlock({ ...block, status: status === "failed" ? "failed" : status === "ready" ? "active" : "resolved", ...(message ? { text: message } : {}), updatedAt: now }, `proposal:${proposal.id}`, null);
    if (proposal.designSessionId) {
      const design = this.#store.getProjection().designSessions[proposal.designSessionId];
      if (design) this.#recordDesignSession({ ...design, status: status === "approved" ? "deployed" : status === "rejected" ? "abandoned" : design.status, updatedAt: now }, `proposal:${proposal.id}`, null);
    }
    void this.#notifier.proposalChanged(proposal, this.#store.getProjection());
    return proposal;
  }

  async approveMutation(mutationId: string, actorId: string, idempotencyKey: string): Promise<MutationView> {
    const projection = this.#store.getProjection();
    const mutation = requiredMutation(projection, mutationId);
    if (mutation.status === "applied") {
      this.#materializeGraphNativeAgents(mutation.diff.operations);
      return mutation;
    }
    if (mutation.status !== "proposed" && mutation.status !== "partially_applied") {
      throw new Error(`mutation cannot be approved from ${mutation.status}`);
    }

    const judgment = this.#append({
      eventType: "Judgment",
      aggregateType: "mutation",
      aggregateId: mutationId,
      actorId,
      correlationId: mutation.correlationId,
      causationId: null,
      idempotencyKey,
      payload: { kind: "mutation_approved", aggregateId: mutationId },
    });
    if (!judgment.inserted) return requiredMutation(judgment.projection, mutationId);

    const operations = mutation.diff.operations.filter((operation) => mutation.pendingOperationIds.includes(operation.operationId));
    const applied = this.#append({
      eventType: "GraphMutation",
      aggregateType: "mutation",
      aggregateId: mutationId,
      actorId,
      correlationId: mutation.correlationId,
      causationId: judgment.event.eventId,
      idempotencyKey: `mutation:${mutationId}:approved:${judgment.event.eventId}`,
      payload: {
        phase: "applied",
        mutationId,
        operations,
        appliedOperationIds: operations.map((operation) => operation.operationId),
        pendingOperationIds: [],
        rejectedOperationIds: [],
      },
    });
    const updated = requiredMutation(applied.projection, mutationId);
    this.#materializeGraphNativeAgents(mutation.diff.operations);
    await this.#notifier.mutationChanged(updated, applied.projection);
    await this.#dispatchMutation(updated);
    return updated;
  }

  async rejectMutation(
    mutationId: string,
    actorId: string,
    idempotencyKey: string,
    reason: string,
    revisionRequested = false,
  ): Promise<MutationView> {
    const mutation = requiredMutation(this.#store.getProjection(), mutationId);
    const judgment = this.#append({
      eventType: "Judgment",
      aggregateType: "mutation",
      aggregateId: mutationId,
      actorId,
      correlationId: mutation.correlationId,
      causationId: null,
      idempotencyKey,
      payload: { kind: "mutation_rejected", aggregateId: mutationId, reason },
    });
    if (!judgment.inserted) return requiredMutation(judgment.projection, mutationId);
    const rejected = this.#append({
      eventType: "GraphMutation",
      aggregateType: "mutation",
      aggregateId: mutationId,
      actorId,
      correlationId: mutation.correlationId,
      causationId: judgment.event.eventId,
      idempotencyKey: `mutation:${mutationId}:${revisionRequested ? "superseded" : "rejected"}`,
      payload: {
        phase: revisionRequested ? "superseded" : "rejected",
        mutationId,
        rejectedOperationIds: mutation.pendingOperationIds,
      },
    });
    const updated = requiredMutation(rejected.projection, mutationId);
    await this.#notifier.mutationChanged(updated, rejected.projection);
    return updated;
  }

  async acceptWork(workId: string, actorId: string, idempotencyKey: string): Promise<AppProjection> {
    const projection = this.#store.getProjection();
    const work = requiredWork(projection, workId);
    assertWorkTransition(work.status, "completed");
    const run = latestRunForWork(projection, workId);
    const evidence = Object.values(projection.evidence).filter((item) => item.runId === run.id);
    const kinds = new Set(evidence.map((item) => item.kind));
    for (const required of ["patch", "test-report", "execution-summary"] as const) {
      if (!kinds.has(required)) throw new Error(`missing required evidence: ${required}`);
    }
    const testReport = evidence.find((item) => item.kind === "test-report");
    if (!testReport?.passed) throw new Error("tests did not pass");

    const result = this.#append({
      eventType: "Judgment",
      aggregateType: "work",
      aggregateId: workId,
      actorId,
      correlationId: run.correlationId,
      causationId: null,
      idempotencyKey,
      payload: { kind: "acceptance_approved", aggregateId: workId, workId, runId: run.id },
    });
    await this.#notifier.runChanged(requiredRun(result.projection, run.id), result.projection);
    return result.projection;
  }

  async rejectWork(workId: string, actorId: string, idempotencyKey: string, reason: string): Promise<AppProjection> {
    const projection = this.#store.getProjection();
    const work = requiredWork(projection, workId);
    assertWorkTransition(work.status, "approved");
    const run = latestRunForWork(projection, workId);
    const result = this.#append({
      eventType: "Judgment",
      aggregateType: "work",
      aggregateId: workId,
      actorId,
      correlationId: run.correlationId,
      causationId: null,
      idempotencyKey,
      payload: { kind: "acceptance_rejected", aggregateId: workId, workId, runId: run.id, reason },
    });
    await this.#notifier.runChanged(requiredRun(result.projection, run.id), result.projection);
    return result.projection;
  }

  async cancelRun(runId: string, actorId: string, idempotencyKey: string): Promise<RunView> {
    const projection = this.#store.getProjection();
    const run = requiredRun(projection, runId);
    const canceled = await this.#executor.cancel(runId);
    if (!canceled) throw new Error(`run is not active: ${runId}`);
    const result = this.#append({
      eventType: "ExecutionEvent",
      aggregateType: "run",
      aggregateId: runId,
      actorId,
      correlationId: run.correlationId,
      causationId: null,
      idempotencyKey,
      payload: { phase: "canceled", runId, workId: run.workId, mutationId: run.mutationId, stage: "canceled", message: "Canceled by user" },
    });
    const updated = requiredRun(result.projection, runId);
    await this.#notifier.runChanged(updated, result.projection);
    return updated;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#activeRuns.values()]);
  }

  #recordClarification(input: SubmitIntentInput, correlationId: string, causationId: string, text: string, reasoningSummary: string, diagnostics: Array<{ code: string; path: string; message: string }>): SubmitIntentResult {
    const responseId = `resp_${ulid()}`;
    const produced = this.#append({ eventType: "StewardResponseProduced", aggregateType: "channel", aggregateId: input.conversationId, actorId: this.#config.stewardActorId, correlationId, causationId, idempotencyKey: `response:${input.channel}:${input.messageId}:validation`, payload: { id: responseId, sourceMessageId: input.messageId, conversationId: input.conversationId, kind: "clarification", text, reasoningSummary } });
    const now = this.#now();
    this.#recordConversationBlock({ id: `block_${ulid()}`, conversationId: input.conversationId, sourceMessageId: input.messageId, kind: "recovery", title: "部署前检查未通过", text, status: "active", diagnostics, createdAt: now, updatedAt: now }, correlationId, produced.event.eventId);
    return { kind: "clarification", response: requiredStewardResponse(produced.projection, responseId), replayed: false };
  }

  #recordConversationBlock(block: ConversationBlock, correlationId: string, causationId: string | null): void {
    this.#append({ eventType: "ConversationBlockEvent", aggregateType: "channel", aggregateId: block.conversationId, actorId: this.#config.stewardActorId, correlationId, causationId, idempotencyKey: `conversation-block:${block.id}:${block.updatedAt}`, payload: { block } });
  }

  #recordDesignSession(session: DesignSession, correlationId: string, causationId: string | null): void {
    this.#append({ eventType: "DesignSessionEvent", aggregateType: "channel", aggregateId: session.id, actorId: this.#config.stewardActorId, correlationId, causationId, idempotencyKey: `design-session:${session.id}:${session.updatedAt}`, payload: { session } });
  }

  #recordProposal(proposal: ProductionProposal, correlationId: string, causationId: string | null): void {
    this.#append({ eventType: "ProductionProposalEvent", aggregateType: "work", aggregateId: proposal.id, actorId: this.#config.stewardActorId, correlationId, causationId, idempotencyKey: `production-proposal:${proposal.id}:${proposal.updatedAt}:${proposal.status}`, payload: { proposal } });
  }

  async #dispatchMutation(mutation: MutationView): Promise<void> {
    if (!isRepositoryExecutionMutation(mutation)) return;
    const projection = this.#store.getProjection();
    const work = workFromDiff(projection, mutation);
    const runId = `run_${ulid()}`;
    let contract: ExecutionContract;
    try {
      contract = await this.#executor.prepare({
        runId,
        work,
        executorActorId: this.#config.executorActorId,
        ownerActorId: this.#config.ownerActorId,
        acceptorActorId: this.#config.ownerActorId,
        repositoryId: this.#config.repositoryId,
        testCommandArgv: this.#config.testCommandArgv,
      });
    } catch (error) {
      const failed = this.#appendExecution({
        phase: "failed",
        runId,
        workId: work.id,
        mutationId: mutation.id,
        correlationId: mutation.correlationId,
        stage: "prepare",
        message: "Executor preparation failed",
        error: errorMessage(error),
        idempotencyKey: `run:${runId}:prepare-failed`,
      });
      await this.#notifier.runChanged(requiredRun(failed.projection, runId), failed.projection);
      return;
    }

    const dispatched = this.#appendExecution({
      phase: "dispatched",
      runId,
      workId: work.id,
      mutationId: mutation.id,
      correlationId: mutation.correlationId,
      stage: "prepared",
      message: "Execution contract prepared",
      contract,
      idempotencyKey: `run:${runId}:dispatched`,
    });
    await this.#notifier.runChanged(requiredRun(dispatched.projection, runId), dispatched.projection);

    const task = this.#runExecution(contract, mutation).finally(() => this.#activeRuns.delete(runId));
    this.#activeRuns.set(runId, task);
  }

  async #runExecution(contract: ExecutionContract, mutation: MutationView): Promise<void> {
    const started = this.#appendExecution({
      phase: "started",
      runId: contract.runId,
      workId: contract.workId,
      mutationId: mutation.id,
      correlationId: mutation.correlationId,
      stage: "claude",
      message: "Claude Code started",
      idempotencyKey: `run:${contract.runId}:started`,
    });
    await this.#notifier.runChanged(requiredRun(started.projection, contract.runId), started.projection);

    try {
      let progressIndex = 0;
      const result = await this.#executor.execute(contract, async (progress) => {
        if (this.#store.getProjection().runs[contract.runId]?.phase === "canceled") return;
        progressIndex += 1;
        const appended = this.#appendExecution({
          phase: "progress",
          runId: contract.runId,
          workId: contract.workId,
          mutationId: mutation.id,
          correlationId: mutation.correlationId,
          stage: progress.stage,
          message: progress.message,
          idempotencyKey: `run:${contract.runId}:progress:${progressIndex}`,
        });
        await this.#notifier.runChanged(requiredRun(appended.projection, contract.runId), appended.projection);
      });

      if (this.#store.getProjection().runs[contract.runId]?.phase === "canceled") return;

      let projection = this.#store.getProjection();
      for (const evidenceInput of result.evidence) {
        const evidence = EvidenceSchema.parse(evidenceInput);
        const appended = this.#append({
          eventType: "EvidenceAttached",
          aggregateType: "run",
          aggregateId: contract.runId,
          actorId: this.#config.executorActorId,
          correlationId: mutation.correlationId,
          causationId: null,
          idempotencyKey: `run:${contract.runId}:evidence:${evidence.artifactId}`,
          payload: evidence,
        });
        projection = appended.projection;
      }
      const testPassed = result.evidence.some((evidence) => evidence.kind === "test-report" && evidence.passed === true);
      const phase = result.success && testPassed ? "succeeded" : "failed";
      const finished = this.#appendExecution({
        phase,
        runId: contract.runId,
        workId: contract.workId,
        mutationId: mutation.id,
        correlationId: mutation.correlationId,
        stage: phase,
        message: result.summary,
        ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
        durationMs: result.durationMs,
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        idempotencyKey: `run:${contract.runId}:${phase}`,
      });
      await this.#notifier.runChanged(requiredRun(finished.projection, contract.runId), finished.projection);
    } catch (error) {
      if (this.#store.getProjection().runs[contract.runId]?.phase === "canceled") return;
      const failed = this.#appendExecution({
        phase: "failed",
        runId: contract.runId,
        workId: contract.workId,
        mutationId: mutation.id,
        correlationId: mutation.correlationId,
        stage: "executor-error",
        message: "Executor failed",
        error: errorMessage(error),
        idempotencyKey: `run:${contract.runId}:failed`,
      });
      await this.#notifier.runChanged(requiredRun(failed.projection, contract.runId), failed.projection);
    }
  }

  #appendExecution(input: {
    phase: RunView["phase"];
    runId: string;
    workId: string;
    mutationId: string;
    correlationId: string;
    stage: string;
    message: string;
    idempotencyKey: string;
    contract?: ExecutionContract;
    sessionId?: string;
    durationMs?: number;
    costUsd?: number;
    error?: string;
  }) {
    const { correlationId, idempotencyKey, ...payload } = input;
    return this.#append({
      eventType: "ExecutionEvent",
      aggregateType: "run",
      aggregateId: input.runId,
      actorId: this.#config.executorActorId,
      correlationId,
      causationId: null,
      idempotencyKey,
      payload,
    });
  }

  #append<TPayload>(request: Parameters<EventStorePort["append"]>[0] & { payload: TPayload }) {
    return this.#store.append({ occurredAt: this.#now(), ...request });
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #applySystemGraphOperations(operations: WeaveOperation[], idempotencyKey: string, actorId: string): AppProjection {
    if (operations.length === 0) return this.#store.getProjection();
    return this.#append({
      eventType: "GraphMutation",
      aggregateType: "graph",
      aggregateId: "graph:main",
      actorId,
      correlationId: idempotencyKey,
      causationId: null,
      idempotencyKey,
      payload: {
        phase: "applied",
        mutationId: idempotencyKey,
        operations,
        appliedOperationIds: operations.map((operation) => operation.operationId),
        pendingOperationIds: [],
        rejectedOperationIds: [],
      },
    }).projection;
  }

  #materializeCollaborationGraph(change: CollaborationChange, message: string): void {
    const projection = this.#store.getProjection();
    const operations: WeaveOperation[] = [];
    if (change.kind === "step-run") {
      const stepRun = change.entity;
      const run = projection.flowRuns[stepRun.flowRunId];
      const flow = run ? projection.flows[run.flowId] : undefined;
      const step = flow?.steps.find((candidate) => candidate.id === stepRun.stepId);
      const existing = projection.graph.nodes.find((node) => node.id === stepRun.id);
      const status = stepRun.phase === "completed" ? "completed" : stepRun.phase === "failed" ? "failed" : stepRun.phase === "cancelled" ? "canceled" : stepRun.phase === "running" ? "running" : "approved";
      if (existing) {
        operations.push({ operationId: `update-${safeOperationId(stepRun.id)}-${safeOperationId(stepRun.phase)}`, op: "update_node", explanation: "Update Run step state", nodeId: stepRun.id, patch: { status, description: message } });
      } else if (run && step) {
        operations.push({
          operationId: `add-${safeOperationId(stepRun.id)}`,
          op: "add_node",
          explanation: "Materialize Run step",
          node: {
            id: stepRun.id,
            name: step.name,
            type: "work",
            kind: "step",
            workType: step.kind === "human" ? "approval" : "execute",
            parentWorkId: run.id,
            flowVersionId: `artifact:flow:${run.flowId}:v${run.flowVersion}`,
            subgraphId: `run:${run.id}`,
            description: message,
            status,
            acceptanceCriteria: ["Step produces a durable collaboration result"],
            risk: step.kind === "human" ? "red" : "yellow",
            createdAt: stepRun.createdAt,
            updatedAt: stepRun.updatedAt,
          },
        });
        operations.push({ operationId: `contain-${safeOperationId(stepRun.id)}`, op: "add_edge", explanation: "Add StepRun to Run", edge: { id: `edge:run-contains:${stepRun.id}`, type: "contains", from: run.id, to: stepRun.id, subgraphId: `run:${run.id}` } });
        if (projection.graph.nodes.some((node) => node.id === stepRun.actorId)) {
          operations.push({ operationId: `assign-${safeOperationId(stepRun.id)}`, op: "add_edge", explanation: "Assign actor to StepRun", edge: { id: `edge:run-assignment:${stepRun.id}`, type: "assignment", from: stepRun.actorId, to: stepRun.id, role: "executor", subgraphId: `run:${run.id}` } });
        }
        for (const dependency of step.dependsOn) {
          const dependencyId = `steprun:${run.id}:${dependency}`;
          if (projection.graph.nodes.some((node) => node.id === dependencyId)) {
            operations.push({ operationId: `depend-${safeOperationId(stepRun.id)}-${safeOperationId(dependencyId)}`, op: "add_edge", explanation: "Materialize runtime dependency", edge: { id: `edge:run-dependency:${stepRun.id}:${dependencyId}`, type: "depends_on", from: stepRun.id, to: dependencyId, condition: `${step.join?.mode ?? "all"}:${step.condition}`, subgraphId: `run:${run.id}` } });
          }
        }
      }
    } else if (change.kind === "step-result") {
      for (const artifact of change.entity.artifacts) {
        if (!projection.graph.nodes.some((node) => node.id === artifact.artifactId)) {
          operations.push({ operationId: `add-${safeOperationId(artifact.artifactId)}`, op: "add_node", explanation: "Materialize Step artifact", node: { id: artifact.artifactId, name: artifact.summary || artifact.artifactId, type: "artifact", kind: "file", uri: artifact.uri, sha256: artifact.sha256, mediaType: artifact.mediaType, summary: artifact.summary, subgraphId: `run:${change.entity.flowRunId}`, createdAt: change.entity.completedAt, updatedAt: change.entity.completedAt } });
        }
        if (!projection.graph.edges.some((edge) => edge.id === `edge:produces:${change.entity.stepRunId}:${artifact.artifactId}`)) {
          operations.push({ operationId: `produce-${safeOperationId(change.entity.stepRunId)}-${safeOperationId(artifact.artifactId)}`, op: "add_edge", explanation: "Link Step result artifact", edge: { id: `edge:produces:${change.entity.stepRunId}:${artifact.artifactId}`, type: "produces", from: change.entity.stepRunId, to: artifact.artifactId, subgraphId: `run:${change.entity.flowRunId}` } });
        }
      }
    } else if (change.kind === "permission-lease") {
      for (const capability of change.entity.capabilities) {
        const target = projection.graph.nodes.find((node) => node.type === "capability" && node.kind === capability);
        if (!target) continue;
        const edgeId = `edge:lease:${change.entity.id}:${target.id}`;
        if (projection.graph.edges.some((edge) => edge.id === edgeId)) continue;
        operations.push({ operationId: `authorize-${safeOperationId(edgeId)}`, op: "add_edge", explanation: "Materialize run-scoped permission lease", edge: { id: edgeId, type: "authorization", from: change.entity.actorId, to: target.id, permission: capability.includes("write") ? "write" : capability === "test-command" ? "execute" : "read", scope: change.entity.stepRunId ?? change.entity.flowRunId, expiresAt: change.entity.expiresAt, source: change.entity.id, subgraphId: `run:${change.entity.flowRunId}` } });
      }
    }
    this.#applySystemGraphOperations(operations, `collaboration-graph:${change.kind}:${change.entity.id}:${"updatedAt" in change.entity ? change.entity.updatedAt : message}`, "system:flow-engine");
  }

  #materializeGraphNativeAgents(operations: WeaveOperation[]): void {
    const graphNativeActors = operations.flatMap((operation) =>
      operation.op === "add_node"
      && operation.node.type === "actor"
      && operation.node.kind === "agent"
      && operation.node.source === "graph-native"
      && (operation.node.adapterKind === "claude-code" || operation.node.adapterKind === "codex")
        ? [operation.node]
        : []);
    for (const actor of graphNativeActors) {
      if (this.#store.getProjection().agents[actor.id]) continue;
      const engine = actor.adapterKind;
      if (engine !== "claude-code" && engine !== "codex") continue;
      const now = this.#now();
      const parentAgentId = operations.find((operation) => operation.op === "add_edge" && operation.edge.type === "delegation" && operation.edge.to === actor.id);
      const spec: AgentSpec = {
        id: `artifact:agent-spec:${actor.id}:v1`,
        agentId: actor.id,
        version: 1,
        engine,
        prompt: actor.harnessPrompt ?? `Act as ${actor.name} inside the assigned Mycel production subgraph. Return concrete status, evidence, and handoff information.`,
        skills: actor.skills ?? [],
        tools: actor.tools ?? ["Read", "Glob", "Grep"],
        fileRefs: [],
        lifecycle: actor.lifecycle ?? "flow-scoped",
        memoryPolicy: actor.lifecycle === "run-scoped" ? "run" : actor.lifecycle === "persistent" ? "session" : "flow",
        maxTurns: 12,
        maxBudgetUsd: 1,
        canOrchestrate: actor.canOrchestrate ?? false,
        maxDelegationDepth: actor.canOrchestrate ? 2 : 0,
        maxFanOut: actor.canOrchestrate ? 4 : 0,
        createdAt: now,
      };
      this.recordAgentProfile({
        id: actor.id,
        name: actor.name,
        source: "graph-native",
        adapterKind: engine,
        status: "online",
        capabilities: uniqueStrings(["graph-harness", ...spec.tools, ...spec.skills, ...(spec.canOrchestrate ? ["orchestrate-agents"] : [])]),
        contractLevel: "control",
        lifecycle: spec.lifecycle,
        specVersionId: spec.id,
        ...(parentAgentId?.op === "add_edge" ? { parentAgentId: parentAgentId.edge.from } : {}),
        ...(actor.subgraphId ? { subgraphId: actor.subgraphId } : {}),
        registeredAt: now,
        updatedAt: now,
      }, spec);
    }
  }
}

function isRepositoryExecutionMutation(mutation: MutationView): boolean {
  return mutation.diff.operations.some((operation) => operation.op === "add_node" && operation.node.type === "work" && operation.node.kind === "run")
    && mutation.diff.operations.some((operation) => operation.op === "add_edge" && operation.edge.type === "authorization" && operation.edge.to === "cap:repo-write");
}

function uniqueStrings(values: string[]): string[] { return [...new Set(values)]; }

function collaborationRunId(change: CollaborationChange, projection: AppProjection): string {
  if (change.kind === "step-attempt") {
    const stepRun = projection.stepRuns?.[change.entity.stepRunId];
    if (!stepRun) throw new Error(`step run not found for attempt: ${change.entity.stepRunId}`);
    return stepRun.flowRunId;
  }
  return change.entity.flowRunId;
}

function collaborationActorId(change: CollaborationChange): string {
  if (change.kind === "step-run") return change.entity.actorId;
  if (change.kind === "step-attempt") return change.entity.producerActorId ?? change.entity.requestedActorId;
  if (change.kind === "step-result") return change.entity.producerActorId;
  if (change.kind === "human-task") return change.entity.claimedByActorId ?? change.entity.assignedActorId;
  return change.entity.actorId;
}

function seedOperations(config: ApplicationConfig, now: string): WeaveOperation[] {
  const nodes: GraphNode[] = [
    { id: config.ownerActorId, name: "Owner", type: "actor", kind: "human", source: "human", status: "online", createdAt: now, updatedAt: now },
    { id: config.stewardActorId, name: "Steward", type: "actor", kind: "agent", source: "system", adapterKind: "claude-code", lifecycle: "persistent", runtime: "claude-code", status: "online", createdAt: now, updatedAt: now },
    { id: config.executorActorId, name: "Claude Code", type: "actor", kind: "agent", source: "adopted", adapterKind: "claude-code", lifecycle: "persistent", runtime: "claude-code", status: "online", createdAt: now, updatedAt: now },
    { id: "agent:codex", name: "Codex CLI", type: "actor", kind: "agent", source: "adopted", adapterKind: "codex", lifecycle: "persistent", runtime: "codex", status: "offline", createdAt: now, updatedAt: now },
    { id: "cap:claude-code", name: "Claude Code CLI", type: "capability", kind: "claude-code", scope: "local", constraints: {}, createdAt: now, updatedAt: now },
    { id: "cap:codex", name: "Codex CLI", type: "capability", kind: "codex", scope: "local", constraints: {}, createdAt: now, updatedAt: now },
    { id: "cap:orchestrate-agents", name: "Multi-agent orchestration", type: "capability", kind: "orchestrate-agents", scope: "bounded-subgraph", constraints: { maxDelegationDepth: 2, maxFanOut: 4 }, createdAt: now, updatedAt: now },
    { id: "cap:repo-read", name: "Repository read", type: "capability", kind: "repository-read", scope: config.repositoryId, constraints: {}, createdAt: now, updatedAt: now },
    { id: "cap:repo-write", name: "Repository write", type: "capability", kind: "repository-write", scope: config.repositoryId, constraints: { runScoped: true }, createdAt: now, updatedAt: now },
    { id: "cap:test", name: "Configured test command", type: "capability", kind: "test-command", scope: config.testCommandId, constraints: { argv: config.testCommandArgv }, createdAt: now, updatedAt: now },
  ];
  const nodeOperations: WeaveOperation[] = nodes.map((node, index) => ({
    operationId: `bootstrap-node-${index}`,
    op: "add_node",
    explanation: "Bootstrap the local demo graph",
    node,
  }));
  return [
    ...nodeOperations,
    { operationId: "bootstrap-equip-claude", op: "add_edge", explanation: "Equip Claude Code", edge: { id: "edge:equip-claude", type: "equipped_with", from: config.executorActorId, to: "cap:claude-code" } },
    { operationId: "bootstrap-equip-codex", op: "add_edge", explanation: "Equip Codex", edge: { id: "edge:equip-codex", type: "equipped_with", from: "agent:codex", to: "cap:codex" } },
    { operationId: "bootstrap-orchestrate-steward", op: "add_edge", explanation: "Allow Steward to compose bounded Agent teams", edge: { id: "edge:orchestrate-steward", type: "equipped_with", from: config.stewardActorId, to: "cap:orchestrate-agents" } },
    { operationId: "bootstrap-read-claude", op: "add_edge", explanation: "Allow repository reading", edge: { id: "edge:read-claude", type: "authorization", from: config.executorActorId, to: "cap:repo-read", scope: config.repositoryId, source: "bootstrap" } },
    { operationId: "bootstrap-test-claude", op: "add_edge", explanation: "Equip the configured test", edge: { id: "edge:test-claude", type: "equipped_with", from: config.executorActorId, to: "cap:test" } },
  ];
}

function requiredMutation(projection: AppProjection, id: string): MutationView {
  const mutation = projection.mutations[id];
  if (!mutation) throw new Error(`mutation not found: ${id}`);
  return mutation;
}

function requiredStewardResponse(projection: AppProjection, id: string): StewardResponseView {
  const response = projection.stewardResponses.find((candidate) => candidate.id === id);
  if (!response) throw new Error(`steward response not found: ${id}`);
  return response;
}

function requiredProposal(projection: AppProjection, id: string): ProductionProposal {
  const proposal = projection.productionProposals?.[id];
  if (!proposal) throw new Error(`production proposal not found: ${id}`);
  return proposal;
}

function requiredChangeSet(projection: AppProjection, id: string): ChangeSet {
  const changeSet = projection.changeSets?.[id];
  if (!changeSet) throw new Error(`ChangeSet not found: ${id}`);
  return changeSet;
}

function isStewardCommandDraft(command: unknown): command is StewardCommandDraft {
  return Boolean(command && typeof command === "object" && "action" in command);
}

function latestDesignSession(projection: AppProjection, conversationId: string): DesignSession | undefined {
  return Object.values(projection.designSessions ?? {})
    .filter((session) => session.conversationId === conversationId && session.status === "clarifying")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function conversationHistory(
  projection: AppProjection,
  conversationId: string,
  currentMessageId: string,
): Array<{ role: "user" | "steward"; text: string }> {
  return [
    ...projection.messages
      .filter((message) => message.conversationId === conversationId && message.id !== currentMessageId)
      .map((message) => ({ role: "user" as const, text: message.text, occurredAt: message.occurredAt })),
    ...(projection.stewardResponses ?? [])
      .filter((response) => response.conversationId === conversationId)
      .map((response) => ({ role: "steward" as const, text: response.text, occurredAt: response.occurredAt })),
  ]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .slice(-12)
    .map(({ role, text }) => ({ role, text }));
}

function requiredRun(projection: AppProjection, id: string): RunView {
  const run = projection.runs[id];
  if (!run) throw new Error(`run not found: ${id}`);
  return run;
}

function requiredWork(projection: AppProjection, id: string): WorkNode {
  const node = projection.graph.nodes.find((candidate) => candidate.id === id);
  if (!node || node.type !== "work") throw new Error(`work not found: ${id}`);
  return node;
}

function workFromDiff(projection: AppProjection, mutation: MutationView): WorkNode {
  const operation = mutation.diff.operations.find(
    (candidate): candidate is Extract<WeaveOperation, { op: "add_node" }> =>
      candidate.op === "add_node" && candidate.node.type === "work",
  );
  if (!operation || operation.node.type !== "work") throw new Error("mutation does not create a Work");
  return requiredWork(projection, operation.node.id);
}

function latestRunForWork(projection: AppProjection, workId: string): RunView {
  const runs = Object.values(projection.runs)
    .filter((run) => run.workId === workId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const run = runs[0];
  if (!run) throw new Error(`run not found for work: ${workId}`);
  return run;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeCapabilityId(adapterKind: AgentProfile["adapterKind"]): string {
  if (adapterKind === "claude-code") return "cap:claude-code";
  if (adapterKind === "codex") return "cap:codex";
  return `cap:runtime:${adapterKind}`;
}

function safeOperationId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
