import {
  applyOperations,
  emptyGraph,
  type EventEnvelope,
  type AgentProfile,
  type AgentSession,
  type AgentSpec,
  type AnyWorkerSpecVersion,
  type AttentionItem,
  type ConversationBlock,
  type ControlCommand,
  type ChangeSet,
  type DesignSession,
  type Evidence,
  type FlowDefinition,
  type FlowRun,
  type HumanTask,
  type PermissionLease,
  type PermissionRequest,
  type ProductionProposal,
  type StepAttempt,
  type StepResult,
  type StepRun,
  type Task,
  type TaskAttempt,
  type GraphState,
  type RiskLevel,
  type WeaveDiff,
  type WeaveOperation,
  type WorkStatus,
  type WorkerProfile,
  type WorkerSession,
  legacyAgentProfileToWorker,
  legacyAgentSessionToWorker,
  legacyAgentSpecToWorker,
} from "@mycel/domain";

export interface MutationView {
  id: string;
  correlationId: string;
  diff: WeaveDiff;
  aggregateRisk: RiskLevel;
  operationRisks: Record<string, RiskLevel>;
  appliedOperationIds: string[];
  pendingOperationIds: string[];
  rejectedOperationIds: string[];
  status: "proposed" | "partially_applied" | "applied" | "rejected" | "reverted" | "conflicted" | "superseded";
  createdAt: string;
  updatedAt: string;
}

export interface RunView {
  id: string;
  workId: string;
  mutationId: string;
  correlationId: string;
  phase: "dispatched" | "started" | "progress" | "interrupted" | "succeeded" | "failed" | "canceled";
  stage: string;
  message: string;
  contract?: unknown;
  sessionId?: string;
  durationMs?: number;
  costUsd?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JudgmentView {
  id: string;
  kind: "mutation_approved" | "mutation_rejected" | "acceptance_approved" | "acceptance_rejected";
  actorId: string;
  aggregateId: string;
  reason?: string;
  occurredAt: string;
}

export interface ChannelMessageView {
  id: string;
  channel: "dingtalk" | "feishu" | "web";
  conversationId: string;
  actorId: string;
  text: string;
  occurredAt: string;
}

export interface StewardResponseView {
  id: string;
  sourceMessageId: string;
  conversationId: string;
  kind: "answer" | "clarification";
  text: string;
  reasoningSummary: string;
  occurredAt: string;
}

export interface CardView {
  outTrackId: string;
  aggregateId: string;
  cardInstanceId?: string;
  state: string;
  updatedAt: string;
}

export interface AppProjection {
  graph: GraphState;
  mutations: Record<string, MutationView>;
  runs: Record<string, RunView>;
  evidence: Record<string, Evidence>;
  judgments: JudgmentView[];
  messages: ChannelMessageView[];
  stewardResponses: StewardResponseView[];
  cards: Record<string, CardView>;
  agents: Record<string, AgentProfile>;
  agentSpecs: Record<string, AgentSpec>;
  agentSessions: Record<string, AgentSession>;
  workers: Record<string, WorkerProfile>;
  workerSpecs: Record<string, AnyWorkerSpecVersion>;
  workerSessions: Record<string, WorkerSession>;
  tasks: Record<string, Task>;
  taskAttempts: Record<string, TaskAttempt>;
  commands: Record<string, ControlCommand>;
  changeSets: Record<string, ChangeSet>;
  flows: Record<string, FlowDefinition>;
  flowRuns: Record<string, FlowRun>;
  stepRuns: Record<string, StepRun>;
  stepAttempts: Record<string, StepAttempt>;
  stepResults: Record<string, StepResult>;
  humanTasks: Record<string, HumanTask>;
  permissionLeases: Record<string, PermissionLease>;
  permissionRequests: Record<string, PermissionRequest>;
  attention: Record<string, AttentionItem>;
  conversationBlocks: ConversationBlock[];
  designSessions: Record<string, DesignSession>;
  productionProposals: Record<string, ProductionProposal>;
}

export function emptyProjection(): AppProjection {
  return {
    graph: emptyGraph(),
    mutations: {},
    runs: {},
    evidence: {},
    judgments: [],
    messages: [],
    stewardResponses: [],
    cards: {},
    agents: {},
    agentSpecs: {},
    agentSessions: {},
    workers: {},
    workerSpecs: {},
    workerSessions: {},
    tasks: {},
    taskAttempts: {},
    commands: {},
    changeSets: {},
    flows: {},
    flowRuns: {},
    stepRuns: {},
    stepAttempts: {},
    stepResults: {},
    humanTasks: {},
    permissionLeases: {},
    permissionRequests: {},
    attention: {},
    conversationBlocks: [],
    designSessions: {},
    productionProposals: {},
  };
}

interface GraphMutationPayload {
  phase: "proposed" | "applied" | "rejected" | "reverted" | "conflicted" | "superseded";
  mutationId: string;
  diff?: WeaveDiff;
  aggregateRisk?: RiskLevel;
  operationRisks?: Record<string, RiskLevel>;
  operations?: WeaveOperation[];
  appliedOperationIds?: string[];
  pendingOperationIds?: string[];
  rejectedOperationIds?: string[];
}

interface ExecutionPayload {
  phase: RunView["phase"];
  runId: string;
  workId: string;
  mutationId: string;
  stage?: string;
  message?: string;
  contract?: unknown;
  sessionId?: string;
  durationMs?: number;
  costUsd?: number;
  error?: string;
}

export function reduceProjection(current: Readonly<AppProjection>, event: EventEnvelope): AppProjection {
  const projection: AppProjection = structuredClone(current);
  projection.stewardResponses ??= [];
  projection.agents ??= {};
  projection.agentSpecs ??= {};
  projection.agentSessions ??= {};
  projection.workers ??= {};
  projection.workerSpecs ??= {};
  projection.workerSessions ??= {};
  projection.tasks ??= {};
  projection.taskAttempts ??= {};
  projection.commands ??= {};
  projection.changeSets ??= {};
  projection.flows ??= {};
  projection.flowRuns ??= {};
  projection.stepRuns ??= {};
  projection.stepAttempts ??= {};
  projection.stepResults ??= {};
  projection.humanTasks ??= {};
  projection.permissionLeases ??= {};
  projection.permissionRequests ??= {};
  projection.attention ??= {};
  projection.conversationBlocks ??= [];
  projection.designSessions ??= {};
  projection.productionProposals ??= {};

  switch (event.eventType) {
    case "ChannelMessageReceived": {
      const payload = event.payload as Omit<ChannelMessageView, "occurredAt">;
      projection.messages.push({ ...payload, occurredAt: event.occurredAt });
      break;
    }
    case "StewardResponseProduced": {
      const payload = event.payload as Omit<StewardResponseView, "occurredAt">;
      projection.stewardResponses.push({ ...payload, occurredAt: event.occurredAt });
      break;
    }
    case "ConversationBlockEvent": {
      const payload = event.payload as { block: ConversationBlock };
      const index = projection.conversationBlocks.findIndex((block) => block.id === payload.block.id);
      if (index >= 0) projection.conversationBlocks[index] = payload.block;
      else projection.conversationBlocks.push(payload.block);
      break;
    }
    case "DesignSessionEvent": {
      const payload = event.payload as { session: DesignSession };
      projection.designSessions[payload.session.id] = payload.session;
      break;
    }
    case "ProductionProposalEvent": {
      const payload = event.payload as { proposal: ProductionProposal };
      projection.productionProposals[payload.proposal.id] = payload.proposal;
      break;
    }
    case "AgentRuntimeEvent": {
      const payload = event.payload as { profile: AgentProfile; spec?: AgentSpec };
      projection.agents[payload.profile.id] = payload.profile;
      if (payload.spec) projection.agentSpecs[payload.spec.id] = payload.spec;
      projection.workers[payload.profile.id] = legacyAgentProfileToWorker(payload.profile);
      if (payload.spec) projection.workerSpecs[payload.spec.id] = legacyAgentSpecToWorker(payload.spec);
      break;
    }
    case "AgentSessionEvent": {
      const payload = event.payload as { session: AgentSession };
      projection.agentSessions[payload.session.id] = payload.session;
      projection.workerSessions[payload.session.id] = legacyAgentSessionToWorker(payload.session);
      const attentionId = `attention:session:${payload.session.id}`;
      if (payload.session.phase === "blocked") {
        projection.attention[attentionId] = {
          id: attentionId,
          kind: "blocked",
          title: payload.session.lastEvent || `${payload.session.agentId} is blocked`,
          aggregateId: payload.session.id,
          actorId: "human:owner",
          status: "open",
          createdAt: projection.attention[attentionId]?.createdAt ?? event.occurredAt,
          updatedAt: event.occurredAt,
        };
      } else if (["completed", "failed", "interrupted", "canceled"].includes(payload.session.phase)) {
        const existing = projection.attention[attentionId];
        if (existing) projection.attention[attentionId] = { ...existing, status: "resolved", updatedAt: event.occurredAt };
      }
      break;
    }
    case "WorkerRuntimeEvent": {
      const payload = event.payload as { profile: WorkerProfile; spec?: AnyWorkerSpecVersion };
      projection.workers[payload.profile.id] = payload.profile;
      if (payload.spec) projection.workerSpecs[payload.spec.id] = payload.spec;
      break;
    }
    case "WorkerSpecEvent": {
      const payload = event.payload as { spec: AnyWorkerSpecVersion };
      projection.workerSpecs[payload.spec.id] = payload.spec;
      break;
    }
    case "WorkerSessionEvent": {
      const payload = event.payload as { session: WorkerSession };
      projection.workerSessions[payload.session.id] = payload.session;
      break;
    }
    case "TaskEvent": {
      const payload = event.payload as { task: Task };
      projection.tasks[payload.task.id] = payload.task;
      break;
    }
    case "TaskAttemptEvent": {
      const payload = event.payload as { attempt: TaskAttempt };
      projection.taskAttempts[payload.attempt.id] = payload.attempt;
      break;
    }
    case "ControlCommandEvent": {
      const payload = event.payload as { command: ControlCommand };
      projection.commands[payload.command.id] = payload.command;
      break;
    }
    case "ChangeSetEvent": {
      const payload = event.payload as { changeSet: ChangeSet };
      projection.changeSets[payload.changeSet.id] = payload.changeSet;
      break;
    }
    case "FlowDefinitionEvent": {
      const payload = event.payload as { flow: FlowDefinition };
      projection.flows[payload.flow.id] = payload.flow;
      break;
    }
    case "FlowRuntimeEvent": {
      const payload = event.payload as { run: FlowRun; message?: string };
      projection.flowRuns[payload.run.id] = payload.run;
      const attentionId = `attention:flow-run:${payload.run.id}`;
      if (payload.run.phase === "blocked") {
        projection.attention[attentionId] = {
          id: attentionId,
          kind: "blocked",
          title: payload.message ?? `Flow run ${payload.run.id} is blocked`,
          aggregateId: payload.run.id,
          actorId: "human:owner",
          status: "open",
          createdAt: projection.attention[attentionId]?.createdAt ?? event.occurredAt,
          updatedAt: event.occurredAt,
        };
      } else if (["completed", "failed", "canceled"].includes(payload.run.phase)) {
        const existing = projection.attention[attentionId];
        if (existing) projection.attention[attentionId] = { ...existing, status: "resolved", updatedAt: event.occurredAt };
      }
      break;
    }
    case "CollaborationRuntimeEvent": {
      const payload = event.payload as {
        change:
          | { kind: "step-run"; entity: StepRun }
          | { kind: "step-attempt"; entity: StepAttempt }
          | { kind: "step-result"; entity: StepResult }
          | { kind: "human-task"; entity: HumanTask }
          | { kind: "permission-lease"; entity: PermissionLease }
          | { kind: "permission-request"; entity: PermissionRequest };
        message?: string;
      };
      const change = payload.change;
      if (change.kind === "step-run") {
        projection.stepRuns[change.entity.id] = change.entity;
        projectFlowTask(projection, change.entity);
      }
      else if (change.kind === "step-attempt") {
        projection.stepAttempts[change.entity.id] = change.entity;
        projectFlowTaskAttempt(projection, change.entity);
      }
      else if (change.kind === "step-result") {
        projection.stepResults[change.entity.id] = change.entity;
        projectFlowTaskResult(projection, change.entity);
      }
      else if (change.kind === "permission-lease") projection.permissionLeases[change.entity.id] = change.entity;
      else if (change.kind === "human-task") {
        projection.humanTasks[change.entity.id] = change.entity;
        const attentionId = `attention:human-task:${change.entity.id}`;
        if (change.entity.phase === "open" || change.entity.phase === "claimed") {
          projection.attention[attentionId] = {
            id: attentionId,
            kind: "blocked",
            title: payload.message ?? change.entity.instructions,
            aggregateId: change.entity.id,
            actorId: change.entity.assignedActorId,
            status: "open",
            createdAt: projection.attention[attentionId]?.createdAt ?? event.occurredAt,
            updatedAt: event.occurredAt,
          };
        } else {
          const existing = projection.attention[attentionId];
          if (existing) projection.attention[attentionId] = { ...existing, status: "resolved", updatedAt: event.occurredAt };
        }
      } else {
        projection.permissionRequests[change.entity.id] = change.entity;
        const attentionId = `attention:permission:${change.entity.id}`;
        if (change.entity.phase === "open") {
          projection.attention[attentionId] = {
            id: attentionId,
            kind: "decision",
            title: change.entity.reason,
            aggregateId: change.entity.id,
            actorId: "human:owner",
            status: "open",
            createdAt: projection.attention[attentionId]?.createdAt ?? event.occurredAt,
            updatedAt: event.occurredAt,
          };
        } else {
          const existing = projection.attention[attentionId];
          if (existing) projection.attention[attentionId] = { ...existing, status: "resolved", updatedAt: event.occurredAt };
        }
      }
      break;
    }
    case "ContentRetentionEvent":
      break;
    case "GraphMutation": {
      const payload = event.payload as GraphMutationPayload;
      if (payload.phase === "proposed") {
        if (!payload.diff || !payload.aggregateRisk || !payload.operationRisks) throw new Error("invalid proposed mutation event");
        projection.mutations[payload.mutationId] = {
          id: payload.mutationId,
          correlationId: event.correlationId,
          diff: payload.diff,
          aggregateRisk: payload.aggregateRisk,
          operationRisks: payload.operationRisks,
          appliedOperationIds: [],
          pendingOperationIds: payload.pendingOperationIds ?? payload.diff.operations.map((operation) => operation.operationId),
          rejectedOperationIds: [],
          status: "proposed",
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        };
        break;
      }

      const mutation = projection.mutations[payload.mutationId];
      if (!mutation && payload.phase === "applied" && event.aggregateType === "graph") {
        const operations = payload.operations ?? [];
        if (operations.length > 0) projection.graph = applyOperations(projection.graph, operations, event.occurredAt);
        break;
      }
      if (!mutation) throw new Error(`mutation projection missing: ${payload.mutationId}`);
      if (payload.phase === "applied") {
        const operations = payload.operations ?? [];
        if (operations.length > 0) projection.graph = applyOperations(projection.graph, operations, event.occurredAt);
        mutation.appliedOperationIds = unique([...mutation.appliedOperationIds, ...(payload.appliedOperationIds ?? [])]);
        mutation.pendingOperationIds = payload.pendingOperationIds ?? mutation.pendingOperationIds.filter(
          (id) => !mutation.appliedOperationIds.includes(id),
        );
        mutation.rejectedOperationIds = payload.rejectedOperationIds ?? mutation.rejectedOperationIds;
        mutation.status = mutation.pendingOperationIds.length === 0 ? "applied" : "partially_applied";
      } else {
        mutation.status = payload.phase;
        mutation.rejectedOperationIds = payload.rejectedOperationIds ?? mutation.pendingOperationIds;
        mutation.pendingOperationIds = [];
      }
      mutation.updatedAt = event.occurredAt;
      break;
    }
    case "ExecutionEvent": {
      const payload = event.payload as ExecutionPayload;
      const previous = projection.runs[payload.runId];
      projection.runs[payload.runId] = {
        id: payload.runId,
        workId: payload.workId,
        mutationId: payload.mutationId,
        correlationId: event.correlationId,
        phase: payload.phase,
        stage: payload.stage ?? previous?.stage ?? payload.phase,
        message: payload.message ?? previous?.message ?? "",
        ...(payload.contract !== undefined ? { contract: payload.contract } : previous?.contract !== undefined ? { contract: previous.contract } : {}),
        ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : previous?.sessionId !== undefined ? { sessionId: previous.sessionId } : {}),
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : previous?.durationMs !== undefined ? { durationMs: previous.durationMs } : {}),
        ...(payload.costUsd !== undefined ? { costUsd: payload.costUsd } : previous?.costUsd !== undefined ? { costUsd: previous.costUsd } : {}),
        ...(payload.error !== undefined ? { error: payload.error } : previous?.error !== undefined ? { error: previous.error } : {}),
        createdAt: previous?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
      };
      const statusByPhase: Partial<Record<RunView["phase"], WorkStatus>> = {
        dispatched: "approved",
        started: "running",
        progress: "running",
        succeeded: "awaiting_acceptance",
        failed: "failed",
        canceled: "canceled",
        interrupted: "failed",
      };
      const status = statusByPhase[payload.phase];
      if (status) setWorkStatus(projection.graph, payload.workId, status, event.occurredAt);
      break;
    }
    case "EvidenceAttached": {
      const evidence = event.payload as Evidence;
      projection.evidence[evidence.artifactId] = evidence;
      break;
    }
    case "Judgment": {
      const payload = event.payload as Omit<JudgmentView, "id" | "actorId" | "occurredAt"> & { workId?: string };
      projection.judgments.push({
        id: event.eventId,
        kind: payload.kind,
        actorId: event.actorId,
        aggregateId: payload.aggregateId,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        occurredAt: event.occurredAt,
      });
      if (payload.workId && payload.kind === "acceptance_approved") {
        setWorkStatus(projection.graph, payload.workId, "completed", event.occurredAt);
      } else if (payload.workId && payload.kind === "acceptance_rejected") {
        setWorkStatus(projection.graph, payload.workId, "approved", event.occurredAt);
      }
      break;
    }
    case "CardDelivered": {
      const payload = event.payload as Omit<CardView, "updatedAt">;
      projection.cards[payload.outTrackId] = { ...payload, updatedAt: event.occurredAt };
      break;
    }
    case "CardCallbackReceived":
    case "ProjectionRebuilt":
      break;
  }
  return projection;
}

function flowTaskId(flowRunId: string, stepId: string): string {
  return `task:flow:${flowRunId}:${stepId}`;
}

function projectFlowTask(projection: AppProjection, stepRun: StepRun): void {
  const run = projection.flowRuns[stepRun.flowRunId];
  const flow = run?.flowSnapshot ?? (run ? projection.flows[run.flowId] : undefined);
  const step = flow?.steps.find((candidate) => candidate.id === stepRun.stepId);
  if (!run || !flow || !step) return;
  const id = flowTaskId(run.id, step.id);
  const existing = projection.tasks[id];
  const status: Task["status"] = stepRun.phase === "pending" || stepRun.phase === "ready" ? "ready"
    : stepRun.phase === "running" ? "running"
    : stepRun.phase === "blocked" ? "blocked"
    : stepRun.phase === "completed" || stepRun.phase === "skipped" ? "completed"
    : stepRun.phase === "failed" ? "failed" : "canceled";
  projection.tasks[id] = {
    schemaVersion: 1, id, version: (existing?.version ?? 0) + 1, title: step.name, description: step.prompt,
    source: { kind: "flow", flowId: flow.id, flowRunId: run.id, stepId: step.id }, initiatorActorId: "system:flow-engine",
    ownerActorId: "human:owner", candidateWorkerIds: step.kind === "agent" ? [stepRun.actorId] : [], humanActorIds: step.kind === "human" ? [stepRun.actorId] : ["human:owner"],
    workspaceId: flow.workspaceId ?? "repository", permissionCeiling: flow.permissionCeiling,
    acceptanceCriteria: ["Step completes according to its published Flow contract"], priority: "normal", status,
    budget: { maxAttempts: step.maxAttempts, maxRuntimeMs: step.timeoutMs, ...(flow.budget?.maxCostUsd !== undefined ? { maxCostUsd: flow.budget.maxCostUsd } : {}) },
    ...(existing?.currentAttemptId ? { currentAttemptId: existing.currentAttemptId } : {}), attemptIds: existing?.attemptIds ?? [],
    ...(existing?.resultSummary ? { resultSummary: existing.resultSummary } : {}), evidenceIds: existing?.evidenceIds ?? [],
    createdAt: existing?.createdAt ?? stepRun.createdAt, updatedAt: stepRun.updatedAt,
  };
}

function projectFlowTaskAttempt(projection: AppProjection, attempt: StepAttempt): void {
  const stepRun = projection.stepRuns[attempt.stepRunId];
  if (!stepRun) return;
  projectFlowTask(projection, stepRun);
  const taskId = flowTaskId(stepRun.flowRunId, stepRun.stepId);
  const task = projection.tasks[taskId];
  if (!task) return;
  const run = projection.flowRuns[stepRun.flowRunId];
  const step = run?.flowSnapshot?.steps.find((candidate) => candidate.id === stepRun.stepId);
  const id = `task-attempt:${attempt.id}`;
  const existing = projection.taskAttempts[id];
  projection.taskAttempts[id] = {
    schemaVersion: 1, id, taskId, ordinal: attempt.ordinal, version: (existing?.version ?? 0) + 1,
    phase: attempt.phase === "cancelled" ? "canceled" : attempt.phase,
    assigneeKind: step?.kind === "human" ? "human" : "worker",
    ...(step?.kind === "human" ? { humanActorId: attempt.requestedActorId } : { workerId: attempt.producerActorId ?? attempt.requestedActorId }),
    ...(attempt.agentSessionId ? { workerSessionId: attempt.agentSessionId } : {}), ...(attempt.humanTaskId ? { humanTaskId: attempt.humanTaskId } : {}),
    permissionLeaseId: attempt.permissionLeaseId, evidenceIds: existing?.evidenceIds ?? [], ...(attempt.error ? { error: attempt.error } : {}),
    createdAt: existing?.createdAt ?? attempt.startedAt, updatedAt: attempt.completedAt ?? attempt.startedAt,
  };
  projection.tasks[taskId] = { ...task, version: task.version + 1, currentAttemptId: id, attemptIds: task.attemptIds.includes(id) ? task.attemptIds : [...task.attemptIds, id], updatedAt: attempt.completedAt ?? attempt.startedAt };
}

function projectFlowTaskResult(projection: AppProjection, result: StepResult): void {
  const stepRun = projection.stepRuns[result.stepRunId];
  if (!stepRun) return;
  const taskId = flowTaskId(result.flowRunId, stepRun.stepId);
  const task = projection.tasks[taskId];
  if (!task) return;
  const status: Task["status"] = result.status === "completed" || result.status === "skipped" ? "completed" : result.status === "failed" ? "failed" : "canceled";
  projection.tasks[taskId] = { ...task, version: task.version + 1, status, resultSummary: result.summary, evidenceIds: result.artifacts.map((artifact) => artifact.artifactId), updatedAt: result.completedAt };
  if (task.currentAttemptId && projection.taskAttempts[task.currentAttemptId]) {
    const attempt = projection.taskAttempts[task.currentAttemptId]!;
    projection.taskAttempts[attempt.id] = { ...attempt, version: attempt.version + 1, phase: status === "completed" ? "completed" : status === "failed" ? "failed" : "canceled", resultSummary: result.summary, evidenceIds: result.artifacts.map((artifact) => artifact.artifactId), updatedAt: result.completedAt };
  }
}

function setWorkStatus(graph: GraphState, workId: string, status: WorkStatus, updatedAt: string): void {
  const work = graph.nodes.find((node) => node.id === workId && node.type === "work");
  if (work?.type === "work") {
    work.status = status;
    work.updatedAt = updatedAt;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
