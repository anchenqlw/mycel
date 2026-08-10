import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { LocalAgentRuntime, controlCapabilitiesForAdapter, type AgentProbeResult, type AgentRunResult, type NormalizedAgentEvent } from "@mycel/agent-runtime";
import type { ApplicationService, AppProjection } from "@mycel/application";
import { WorkerSpecVersionSchema, type AgentLifecycle, type AgentProfile, type AgentSession, type AgentSpec, type AgentStepExecutionResult, type CollaborationChange, type FlowDefinition, type FlowRun, type StepArtifactRef, type StepAttempt, type WeaveOperation, type WorkerProfile, type WorkerSession, type WorkerSpecVersion } from "@mycel/domain";
import { LocalFlowEngine, type AgentStepInput, type FlowEnginePort } from "@mycel/flow-engine";
import { runChecked } from "@mycel/executor-claude-code";
import { ulid } from "ulid";
import { renderWorkerHarness, type RenderedWorkerHarness } from "./worker-harness.js";
import { WorkerSecretStore, materializeMcpConfig } from "./worker-secrets.js";

export interface ControlPlaneConfig {
  repositoryPath: string;
  dataDir: string;
  maxTurns: number;
  maxBudgetUsd: number;
  claudeModel?: string;
  workspacePath?: (workspaceId: string) => Promise<string>;
}

export class ControlPlaneService implements FlowEnginePort {
  readonly #application: ApplicationService;
  readonly #runtime: LocalAgentRuntime;
  readonly #flowEngine: LocalFlowEngine;
  readonly #config: ControlPlaneConfig;
  readonly #sessionTasks = new Map<string, Promise<AgentRunResult>>();
  readonly #workerSessionTasks = new Map<string, Promise<AgentRunResult>>();
  readonly #flowWorkspaces = new Map<string, string>();
  readonly #flowWorkspaceTasks = new Map<string, Promise<string>>();
  readonly #workerSecrets: WorkerSecretStore;
  #workerSessionObserver?: (session: WorkerSession, result: AgentRunResult) => void | Promise<void>;

  constructor(application: ApplicationService, config: ControlPlaneConfig, runtime = new LocalAgentRuntime()) {
    this.#application = application;
    this.#config = config;
    this.#runtime = runtime;
    this.#flowEngine = new LocalFlowEngine(this);
    this.#workerSecrets = new WorkerSecretStore(config.dataDir);
  }

  async initialize(): Promise<void> {
    const probes = await this.#runtime.probeAll(this.#config.repositoryPath);
    const now = new Date().toISOString();
    const claudeProbe = probes.find((probe) => probe.adapterKind === "claude-code");
    const stewardSpec: AgentSpec = {
      id: "artifact:agent-spec:agent:steward:v1",
      agentId: "agent:steward",
      version: 1,
      engine: "claude-code",
      prompt: "Coordinate Human and Agent Actors through conversation. Autonomously choose direct answers, focused clarification, resource browsing, typed commands, or validated ProductionPlan proposals for durable side effects.",
      skills: ["production-graph-brainstorm", "graph-coordination", "evidence-first"],
      tools: ["Read", "Glob", "Grep", "Bash"],
      fileRefs: [],
      lifecycle: "persistent",
      memoryPolicy: "session",
      maxTurns: this.#config.maxTurns,
      maxBudgetUsd: this.#config.maxBudgetUsd,
      canOrchestrate: true,
      maxDelegationDepth: 2,
      maxFanOut: 4,
      createdAt: this.#application.getProjection().agentSpecs?.["artifact:agent-spec:agent:steward:v1"]?.createdAt ?? now,
    };
    this.#application.recordAgentProfile({
      id: "agent:steward",
      name: "Steward",
      source: "graph-native",
      adapterKind: "claude-code",
      status: claudeProbe?.available === false ? "degraded" : "online",
      ...(claudeProbe?.version ? { version: claudeProbe.version } : {}),
      capabilities: unique(["orchestrate-agents", ...stewardSpec.skills, ...stewardSpec.tools]),
      contractLevel: "control",
      lifecycle: "persistent",
      specVersionId: stewardSpec.id,
      registeredAt: this.#application.getProjection().agents?.["agent:steward"]?.registeredAt ?? now,
      updatedAt: now,
    }, stewardSpec);
    const stewardWorkerSpec = defaultWorkerSpec("agent:steward", "claude-code", now, {
      systemPrompt: stewardSpec.prompt,
      tools: stewardSpec.tools,
      orchestration: true,
    });
    this.#application.recordWorkerProfile(workerProfileFromAgent({
      id: "agent:steward", name: "Steward", source: "graph-native", adapterKind: "claude-code",
      status: claudeProbe?.available === false ? "degraded" : "online", capabilities: unique(["orchestrate-agents", ...stewardSpec.skills, ...stewardSpec.tools]),
      contractLevel: "control", lifecycle: "persistent", registeredAt: this.#application.getProjection().workers["agent:steward"]?.registeredAt ?? now,
      updatedAt: now, ...(claudeProbe?.version ? { version: claudeProbe.version } : {}),
    }, stewardWorkerSpec, claudeProbe?.controlCapabilities ?? controlCapabilitiesForAdapter("claude-code")), stewardWorkerSpec);
    for (const probe of probes) {
      const id = probe.adapterKind === "claude-code" ? "agent:claude" : "agent:codex";
      this.#application.recordAgentProfile({
        id,
        name: probe.adapterKind === "claude-code" ? "Claude Code" : "Codex CLI",
        source: "adopted",
        adapterKind: probe.adapterKind,
        status: probe.available ? "online" : "offline",
        ...(probe.version ? { version: probe.version } : {}),
        capabilities: probe.capabilities,
        contractLevel: "control",
        lifecycle: "persistent",
        registeredAt: this.#application.getProjection().agents?.[id]?.registeredAt ?? now,
        updatedAt: now,
      });
      const workerSpec = defaultWorkerSpec(id, probe.adapterKind, now);
      this.#application.recordWorkerProfile(workerProfileFromAgent({
        id, name: probe.adapterKind === "claude-code" ? "Claude Code" : "Codex CLI", source: "adopted", adapterKind: probe.adapterKind,
        status: probe.available ? "online" : "offline", capabilities: probe.capabilities, contractLevel: "control", lifecycle: "persistent",
        registeredAt: this.#application.getProjection().workers[id]?.registeredAt ?? now, updatedAt: now, ...(probe.version ? { version: probe.version } : {}),
      }, workerSpec, probe.controlCapabilities), workerSpec);
    }
    const projection = this.#application.getProjection();
    this.#flowEngine.restore(Object.values(projection.flows ?? {}), {
      runs: Object.values(projection.flowRuns ?? {}),
      stepRuns: Object.values(projection.stepRuns ?? {}),
      stepAttempts: Object.values(projection.stepAttempts ?? {}),
      stepResults: Object.values(projection.stepResults ?? {}),
      humanTasks: Object.values(projection.humanTasks ?? {}),
      permissionLeases: Object.values(projection.permissionLeases ?? {}),
      permissionRequests: Object.values(projection.permissionRequests ?? {}),
    });
  }

  getProjection(): AppProjection { return this.#application.getProjection(); }

  applyGraphOperations(operations: WeaveOperation[], idempotencyKey: string, actorId: string): AppProjection {
    return this.#application.applyControlGraphOperations(operations, idempotencyKey, actorId);
  }

  setWorkerSessionObserver(observer: (session: WorkerSession, result: AgentRunResult) => void | Promise<void>): void {
    this.#workerSessionObserver = observer;
  }

  get flowEngine(): LocalFlowEngine { return this.#flowEngine; }

  discoverLocalAgents(): Promise<AgentProbeResult[]> {
    return this.#runtime.probeAll(this.#config.repositoryPath);
  }

  adoptLocalAgent(candidate: {
    id: string;
    name: string;
    adapterKind: "claude-code" | "codex";
    version?: string;
    capabilities: string[];
  }): AgentProfile {
    const now = new Date().toISOString();
    const profile: AgentProfile = {
      id: candidate.id,
      name: candidate.name,
      source: "adopted",
      adapterKind: candidate.adapterKind,
      status: "online",
      ...(candidate.version ? { version: candidate.version } : {}),
      capabilities: candidate.capabilities,
      contractLevel: "control",
      lifecycle: "persistent",
      registeredAt: this.#application.getProjection().agents?.[candidate.id]?.registeredAt ?? now,
      updatedAt: now,
    };
    this.#application.recordAgentProfile(profile);
    return profile;
  }

  registerExternalAgent(input: {
    name: string;
    adapterKind: "mcp" | "a2a";
    connectionUri: string;
    capabilities?: string[];
    contractLevel?: AgentProfile["contractLevel"];
  }): AgentProfile {
    const now = new Date().toISOString();
    const id = `agent:external:${slug(input.name)}:${ulid().slice(-8).toLowerCase()}`;
    const profile: AgentProfile = {
      id,
      name: input.name,
      source: "adopted",
      adapterKind: input.adapterKind,
      status: "online",
      capabilities: unique([input.adapterKind, ...(input.capabilities ?? [])]),
      contractLevel: input.contractLevel ?? "status",
      connectionUri: input.connectionUri,
      lifecycle: "persistent",
      registeredAt: now,
      updatedAt: now,
    };
    this.#application.recordAgentProfile(profile);
    return profile;
  }

  adoptExternalAgent(input: {
    name: string;
    adapterKind: "mcp" | "a2a";
    connectionUri: string;
    capabilities: string[];
    contractLevel: AgentProfile["contractLevel"];
  }): AgentProfile {
    return this.registerExternalAgent(input);
  }

  composeAgent(input: {
    name: string;
    engine: "claude-code" | "codex";
    prompt: string;
    skills?: string[];
    tools?: string[];
    fileRefs?: string[];
    lifecycle?: AgentLifecycle;
    canOrchestrate?: boolean;
    parentAgentId?: string;
    subgraphId?: string;
  }): AgentProfile {
    if (input.parentAgentId) this.#assertCanDelegate(input.parentAgentId);
    const now = new Date().toISOString();
    const id = `agent:native:${slug(input.name)}:${ulid().slice(-8).toLowerCase()}`;
    const specId = `artifact:agent-spec:${id}:v1`;
    const lifecycle = input.lifecycle ?? "run-scoped";
    const spec: AgentSpec = {
      id: specId,
      agentId: id,
      version: 1,
      engine: input.engine,
      prompt: input.prompt,
      skills: input.skills ?? [],
      tools: input.tools ?? ["Read", "Glob", "Grep"],
      fileRefs: input.fileRefs ?? [],
      lifecycle,
      memoryPolicy: lifecycle === "flow-scoped" ? "flow" : lifecycle === "run-scoped" ? "run" : "session",
      maxTurns: this.#config.maxTurns,
      maxBudgetUsd: this.#config.maxBudgetUsd,
      canOrchestrate: input.canOrchestrate ?? false,
      maxDelegationDepth: input.canOrchestrate ? 2 : 0,
      maxFanOut: input.canOrchestrate ? 4 : 0,
      createdAt: now,
    };
    const profile: AgentProfile = {
      id,
      name: input.name,
      source: "graph-native",
      adapterKind: input.engine,
      status: "online",
      capabilities: unique(["graph-harness", ...spec.tools, ...spec.skills, ...(spec.canOrchestrate ? ["orchestrate-agents"] : [])]),
      contractLevel: "control",
      lifecycle,
      specVersionId: spec.id,
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
      ...(input.subgraphId ? { subgraphId: input.subgraphId } : {}),
      registeredAt: now,
      updatedAt: now,
    };
    this.#application.recordAgentProfile(profile, spec);
    return profile;
  }

  createNativeWorker(input: {
    name: string;
    spec: Omit<WorkerSpecVersion, "schemaVersion" | "id" | "workerId" | "version" | "createdAt">;
  }): WorkerProfile {
    const now = new Date().toISOString();
    const workerId = `worker:native:${slug(input.name)}:${ulid().slice(-8).toLowerCase()}`;
    const spec = WorkerSpecVersionSchema.parse({ ...input.spec, schemaVersion: 2, id: `worker-spec:${workerId}:v1`, workerId, version: 1, createdAt: now });
    const profile: WorkerProfile = {
      schemaVersion: 2, id: workerId, name: input.name, source: "native", adapterKind: spec.engine.adapter,
      status: "online", capabilities: workerCapabilities(spec), contractLevel: "control", lifecycle: spec.lifecycle,
      defaultSpecVersionId: spec.id, maxConcurrentSessions: spec.sessionPolicy.maxConcurrentSessions,
      controlCapabilities: this.#runtimeCapabilities(spec.engine.adapter), registeredAt: now, updatedAt: now,
    };
    this.#application.recordWorkerProfile(profile, spec);
    return profile;
  }

  publishWorkerSpec(workerId: string, input: Omit<WorkerSpecVersion, "schemaVersion" | "id" | "workerId" | "version" | "createdAt">): WorkerSpecVersion {
    const projection = this.#application.getProjection();
    const worker = projection.workers[workerId];
    if (!worker) throw new Error(`Worker is not registered: ${workerId}`);
    if (worker.source !== "native" && (worker.adapterKind === "mcp" || worker.adapterKind === "a2a")) throw new Error("External Adopted Workers expose a connection contract, not a Mycel-owned Harness");
    const versions = Object.values(projection.workerSpecs).filter((candidate) => candidate.workerId === workerId);
    const version = Math.max(0, ...versions.map((candidate) => candidate.version)) + 1;
    const now = new Date().toISOString();
    const spec = WorkerSpecVersionSchema.parse({ ...input, schemaVersion: 2, id: `worker-spec:${workerId}:v${version}`, workerId, version, createdAt: now });
    this.#application.recordWorkerSpec(spec);
    this.#application.recordWorkerProfile({ ...worker, adapterKind: spec.engine.adapter, lifecycle: spec.lifecycle, capabilities: workerCapabilities(spec), defaultSpecVersionId: spec.id, maxConcurrentSessions: spec.sessionPolicy.maxConcurrentSessions, updatedAt: now }, spec);
    return spec;
  }

  updateWorker(workerId: string, patch: Partial<Pick<WorkerProfile, "name" | "status" | "lifecycle" | "contractLevel" | "connectionUri" | "maxConcurrentSessions">>): WorkerProfile {
    const worker = this.#application.getProjection().workers[workerId];
    if (!worker) throw new Error(`Worker is not registered: ${workerId}`);
    const updated: WorkerProfile = { ...worker, ...patch, updatedAt: new Date().toISOString() };
    this.#application.recordWorkerProfile(updated);
    return updated;
  }

  archiveWorker(workerId: string): WorkerProfile {
    return this.updateWorker(workerId, { status: "offline", lifecycle: "archived" });
  }

  startWorkerSession(input: {
    workerId: string;
    instruction: string;
    mode: "explore" | "execute";
    workspaceId: string;
    cwd: string;
    taskId?: string;
    attemptId?: string;
    workId?: string;
    flowRunId?: string;
    permissionLeaseId?: string;
    workerSpecVersionId?: string;
    resumeProviderSessionId?: string;
    forkedFrom?: string;
    retryOf?: string;
  }): WorkerSession {
    const projection = this.#application.getProjection();
    const worker = projection.workers[input.workerId];
    if (!worker) throw new Error(`Worker is not registered: ${input.workerId}`);
    if (worker.status === "offline") throw new Error(`Worker is offline: ${input.workerId}`);
    if (worker.adapterKind === "mcp" || worker.adapterKind === "a2a") throw new Error(`External ${worker.adapterKind.toUpperCase()} Worker control contract is not configured`);
    const specId = input.workerSpecVersionId ?? worker.defaultSpecVersionId;
    const spec = specId ? projection.workerSpecs[specId] : undefined;
    if (!spec || spec.schemaVersion !== 2) throw new Error(`Worker requires a published WorkerSpec v2: ${input.workerId}`);
    if (spec.workerId !== worker.id) throw new Error(`WorkerSpec ${spec.id} does not belong to ${worker.id}`);
    const active = Object.values(projection.workerSessions).filter((session) => session.workerId === worker.id && ["starting", "running", "blocked"].includes(session.phase));
    if (active.length >= spec.sessionPolicy.maxConcurrentSessions) throw new Error(`Worker concurrent Session limit reached: ${worker.id}`);
    const task = input.taskId ? projection.tasks[input.taskId] : undefined;
    const lease = input.permissionLeaseId ? projection.permissionLeases[input.permissionLeaseId] : undefined;
    const harness = renderWorkerHarness({ spec, ...(task ? { task } : {}), instruction: input.instruction, workspace: { id: input.workspaceId, realPath: input.cwd }, ...(lease ? { permissionLease: lease } : {}) });
    const now = new Date().toISOString();
    const session: WorkerSession = {
      schemaVersion: 2, id: `worker-session_${ulid()}`, workerId: worker.id, adapterKind: worker.adapterKind,
      ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.workId ? { workId: input.workId } : {}), ...(input.flowRunId ? { flowRunId: input.flowRunId } : {}),
      workerSpecVersionId: spec.id, ...(input.permissionLeaseId ? { permissionLeaseId: input.permissionLeaseId } : {}), workspaceId: input.workspaceId,
      phase: "starting", mode: input.mode, instruction: input.instruction, summary: "", lastEvent: "Session queued",
      ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}), ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      rawContentExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(), createdAt: now, updatedAt: now,
    };
    this.#application.recordWorkerSession(session);
    const run = this.#runWorkerSession(session, input.cwd, spec, harness, input.resumeProviderSessionId, Boolean(input.forkedFrom));
    this.#workerSessionTasks.set(session.id, run.finally(() => this.#workerSessionTasks.delete(session.id)));
    return session;
  }

  cancelWorkerSession(sessionId: string): { canceled: boolean; alternative?: string } {
    const session = this.#requiredWorkerSession(sessionId);
    if (!["starting", "running", "blocked"].includes(session.phase)) return { canceled: false, alternative: `Session is already ${session.phase}` };
    const canceled = this.#runtime.cancel(session.adapterKind, session.id);
    if (canceled) this.#application.recordWorkerSession({ ...session, phase: "canceled", lastEvent: "Canceled by user", updatedAt: new Date().toISOString() });
    return canceled ? { canceled: true } : { canceled: false, alternative: "The provider process is no longer active; retry or start a new Session instead." };
  }

  resumeWorkerSession(sessionId: string, instruction: string, input: { cwd: string; workspaceId: string; fork?: boolean }): WorkerSession {
    const previous = this.#requiredWorkerSession(sessionId);
    if (!previous.providerSessionId) throw new Error("This Session has no provider session ID; retry from its summary instead");
    const worker = this.#application.getProjection().workers[previous.workerId]!;
    if (!worker.controlCapabilities.resume) throw new Error("This Worker does not support native resume; retry from its summary instead");
    if (input.fork && !worker.controlCapabilities.fork) throw new Error("This Worker does not support native fork; start a new Session with forkedFrom lineage instead");
    return this.startWorkerSession({ workerId: previous.workerId, instruction, mode: previous.mode, workspaceId: input.workspaceId, cwd: input.cwd, ...(previous.taskId ? { taskId: previous.taskId } : {}), ...(previous.attemptId ? { attemptId: previous.attemptId } : {}), ...(previous.workerSpecVersionId ? { workerSpecVersionId: previous.workerSpecVersionId } : {}), resumeProviderSessionId: previous.providerSessionId, ...(input.fork ? { forkedFrom: previous.id } : {}) });
  }

  retryWorkerSession(sessionId: string, input: { cwd: string; workspaceId: string; instruction?: string }): WorkerSession {
    const previous = this.#requiredWorkerSession(sessionId);
    return this.startWorkerSession({ workerId: previous.workerId, instruction: input.instruction ?? previous.instruction, mode: previous.mode, workspaceId: input.workspaceId, cwd: input.cwd, ...(previous.taskId ? { taskId: previous.taskId } : {}), ...(previous.attemptId ? { attemptId: previous.attemptId } : {}), ...(previous.workerSpecVersionId ? { workerSpecVersionId: previous.workerSpecVersionId } : {}), retryOf: previous.id });
  }

  workerSecretRefs(): string[] { return this.#workerSecrets.list(); }

  configureWorkerSecret(secretRef: string, value: string): { secretRef: string; configured: true } {
    this.#workerSecrets.set(secretRef, value);
    return { secretRef, configured: true };
  }

  deleteWorkerSecret(secretRef: string): { secretRef: string; deleted: boolean } {
    return { secretRef, deleted: this.#workerSecrets.delete(secretRef) };
  }

  startSession(input: {
    agentId: string;
    prompt: string;
    mode: "explore" | "execute";
    workId?: string;
    flowRunId?: string;
    cwd?: string;
  }): AgentSession {
    const profile = this.#application.getProjection().agents?.[input.agentId];
    if (!profile) throw new Error(`agent is not registered: ${input.agentId}`);
    if (profile.status === "offline") throw new Error(`agent is offline: ${input.agentId}`);
    if (profile.adapterKind === "mcp" || profile.adapterKind === "a2a") {
      throw new Error(`external Agent is registered at ${profile.connectionUri ?? "an unknown endpoint"}, but its ${profile.adapterKind} invocation contract is not configured for this local demo`);
    }
    const now = new Date().toISOString();
    const session: AgentSession = {
      id: `session_${ulid()}`,
      agentId: profile.id,
      adapterKind: profile.adapterKind,
      ...(input.workId ? { workId: input.workId } : {}),
      ...(input.flowRunId ? { flowRunId: input.flowRunId } : {}),
      ...(profile.specVersionId ? { specVersionId: profile.specVersionId } : {}),
      phase: "starting",
      mode: input.mode,
      prompt: input.prompt,
      summary: "",
      lastEvent: "Session queued",
      rawContentExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    this.#application.recordAgentSession(session);
    const task = this.#runSession(session, input.cwd ?? this.#config.repositoryPath);
    this.#sessionTasks.set(session.id, task.finally(() => this.#sessionTasks.delete(session.id)));
    return session;
  }

  cancelSession(sessionId: string): boolean {
    const session = this.#application.getProjection().agentSessions?.[sessionId];
    if (!session) throw new Error(`session not found: ${sessionId}`);
    const canceled = this.#runtime.cancel(session.adapterKind, sessionId);
    if (canceled) this.#application.recordAgentSession({ ...session, phase: "canceled", lastEvent: "Canceled by user", updatedAt: new Date().toISOString() });
    return canceled;
  }

  async saveFlow(flow: Omit<FlowDefinition, "createdAt" | "updatedAt"> & { createdAt?: string }): Promise<FlowDefinition> {
    return this.#flowEngine.save(flow);
  }

  async approveProductionProposal(proposalId: string) {
    try {
      const compiled = this.#application.compileProposal(proposalId);
      this.#application.recordCompiledAgents(proposalId);
      await this.saveFlow(compiled.flow);
      const flow = await this.#flowEngine.publish(compiled.flow.id);
      const proposal = this.#application.updateProposalStatus(proposalId, "approved", `已部署 ${flow.name} v${flow.version}。你可以直接在这里启动或继续调整。`);
      return { proposal, flow };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { proposal: this.#application.updateProposalStatus(proposalId, "failed", "部署前检查没有通过，Steward 已保留方案，请根据恢复建议重试。"), recovery: { title: "部署未完成", detail } };
    }
  }

  rejectProductionProposal(proposalId: string, reason?: string) {
    return this.#application.updateProposalStatus(proposalId, "rejected", reason ?? "这个方案已拒绝。告诉我需要调整的部分，我会继续设计。");
  }

  async persistDefinition(flow: FlowDefinition): Promise<void> {
    this.#application.recordFlowDefinition(flow);
  }

  async persistRun(run: FlowRun, message: string): Promise<void> {
    this.#application.recordFlowRun(run, message);
  }

  async persistCollaboration(change: CollaborationChange, message: string, idempotencyKey: string): Promise<void> {
    this.#application.recordCollaboration(change, message, idempotencyKey);
  }

  actorCapabilities(actorId: string): string[] {
    const projection = this.#application.getProjection();
    const profile = projection.agents[actorId];
    const graphCapabilities = projection.graph.edges
      .filter((edge) => edge.from === actorId && (edge.type === "authorization" || edge.type === "equipped_with"))
      .flatMap((edge) => {
        const target = projection.graph.nodes.find((node) => node.id === edge.to);
        return target?.type === "capability" ? [target.kind, target.id] : [];
      });
    const adapterCapabilities = profile && (profile.adapterKind === "claude-code" || profile.adapterKind === "codex") ? ["repository-read"] : [];
    return unique([...(profile?.capabilities ?? []), ...adapterCapabilities, ...graphCapabilities]);
  }

  actorCapacity(actorId: string): number {
    return this.#application.getProjection().agents[actorId]?.maxConcurrentSessions ?? 1;
  }

  async executeAgentStep(input: AgentStepInput): Promise<AgentStepExecutionResult> {
    const workspace = await this.#workspaceForFlowRun(input.run.id);
    const session = this.startSession({
      agentId: input.step.actorId,
      prompt: input.prompt,
      mode: input.permissionLease.capabilities.includes("repository-write") ? "execute" : "explore",
      workId: input.stepRun.id,
      flowRunId: input.run.id,
      cwd: workspace,
    });
    const result = await this.#sessionTasks.get(session.id);
    if (!result) return { status: "failed", summary: "Agent session did not start", agentSessionId: session.id, error: "missing session task" };
    const artifacts = result.success ? await this.#changedFileArtifacts(workspace, input.stepRun.id) : [];
    return {
      status: result.success ? "completed" : "failed",
      summary: result.summary,
      output: parseStructuredOutput(result.summary),
      agentSessionId: session.id,
      artifacts,
      ...(!result.success ? { error: result.stderr.trim() || result.summary } : {}),
    };
  }

  async cancelAgentStep(attempt: StepAttempt): Promise<void> {
    if (attempt.agentSessionId) this.cancelSession(attempt.agentSessionId);
  }

  stop(): void {
    this.#flowEngine.stop();
  }

  async #runWorkerSession(session: WorkerSession, cwd: string, spec: WorkerSpecVersion, harness: RenderedWorkerHarness, providerSessionId?: string, forkSession = false): Promise<AgentRunResult> {
    const running: WorkerSession = { ...session, phase: "running", lastEvent: "Runtime started", updatedAt: new Date().toISOString() };
    this.#application.recordWorkerSession(running);
    let mcpConfig: ReturnType<typeof materializeMcpConfig> | undefined;
    try {
      if (harness.mcpServers.length > 0 && session.adapterKind !== "claude-code") throw new Error("This Codex adapter cannot inject Session-private MCP configuration; use Claude Code or an Adopted external Worker");
      mcpConfig = materializeMcpConfig({ dataDir: this.#config.dataDir, sessionId: session.id, harness, secrets: this.#workerSecrets });
      const result = await this.#runtime.run(session.adapterKind, {
        sessionId: session.id, cwd, prompt: session.instruction, mode: session.mode, systemPrompt: harness.systemPrompt,
        ...(harness.model ? { model: harness.model } : {}), ...(harness.effort ? { effort: harness.effort } : {}),
        maxTurns: harness.maxTurns, maxBudgetUsd: harness.maxBudgetUsd,
        allowedTools: harness.allowedTools, ...(providerSessionId ? { providerSessionId } : {}), ...(forkSession ? { forkSession: true } : {}), ...(mcpConfig.path ? { mcpConfigPath: mcpConfig.path } : {}),
      }, async (item) => this.#recordWorkerNormalizedEvent(running, item));
      const latest = this.#application.getProjection().workerSessions[session.id] ?? running;
      const completed: WorkerSession = { ...latest, phase: result.success ? "completed" : "failed", ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}), summary: result.summary, lastEvent: result.summary, updatedAt: new Date().toISOString() };
      this.#application.recordWorkerSession(completed);
      this.#writeRawSession(completed.id, result);
      await this.#notifyWorkerSession(completed, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = { ...running, phase: "failed" as const, summary: message, lastEvent: message, updatedAt: new Date().toISOString() };
      const result = { success: false, exitCode: null, summary: message, stdout: "", stderr: message, durationMs: 0 };
      this.#application.recordWorkerSession(failed);
      await this.#notifyWorkerSession(failed, result);
      return result;
    } finally {
      mcpConfig?.cleanup();
    }
  }

  async #notifyWorkerSession(session: WorkerSession, result: AgentRunResult): Promise<void> {
    if (!this.#workerSessionObserver) return;
    try { await this.#workerSessionObserver(session, result); }
    catch { /* Session truth is already durable; Task recovery remains available to Steward. */ }
  }

  async #recordWorkerNormalizedEvent(base: WorkerSession, item: NormalizedAgentEvent): Promise<void> {
    if (item.phase === "started" || item.phase === "completed" || item.phase === "failed") return;
    const latest = this.#application.getProjection().workerSessions[base.id] ?? base;
    this.#application.recordWorkerSession({ ...latest, phase: item.phase === "blocked" || item.phase === "permission" ? "blocked" : "running", lastEvent: item.message, updatedAt: item.occurredAt });
  }

  #requiredWorkerSession(sessionId: string): WorkerSession {
    const session = this.#application.getProjection().workerSessions[sessionId];
    if (!session) throw new Error(`Worker Session not found: ${sessionId}`);
    return session;
  }

  #runtimeCapabilities(adapter: "claude-code" | "codex") {
    return controlCapabilitiesForAdapter(adapter);
  }

  async #runSession(session: AgentSession, cwd: string): Promise<AgentRunResult> {
    const profile = this.#application.getProjection().agents[session.agentId];
    if (!profile) throw new Error(`agent is not registered: ${session.agentId}`);
    const spec = profile.specVersionId ? this.#application.getProjection().agentSpecs[profile.specVersionId] : undefined;
    const running = { ...session, phase: "running" as const, lastEvent: "Runtime started", updatedAt: new Date().toISOString() };
    this.#application.recordAgentSession(running);
    try {
      const result = await this.#runtime.run(profile.adapterKind, {
        sessionId: session.id,
        cwd,
        prompt: session.prompt,
        mode: session.mode,
        ...(spec?.prompt ? { systemPrompt: renderHarness(spec) } : {}),
        ...(profile.adapterKind === "claude-code" && this.#config.claudeModel ? { model: this.#config.claudeModel } : {}),
        maxTurns: spec?.maxTurns ?? this.#config.maxTurns,
        maxBudgetUsd: spec?.maxBudgetUsd ?? this.#config.maxBudgetUsd,
      }, async (item) => this.#recordNormalizedEvent(running, item));
      const completed: AgentSession = {
        ...this.#application.getProjection().agentSessions[session.id]!,
        phase: result.success ? "completed" : "failed",
        ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
        summary: result.summary,
        lastEvent: result.summary,
        updatedAt: new Date().toISOString(),
      };
      this.#application.recordAgentSession(completed);
      this.#writeRawSession(completed.id, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed: AgentSession = { ...running, phase: "failed", summary: message, lastEvent: message, updatedAt: new Date().toISOString() };
      this.#application.recordAgentSession(failed);
      return { success: false, exitCode: null, summary: message, stdout: "", stderr: message, durationMs: 0 };
    }
  }

  async #recordNormalizedEvent(base: AgentSession, item: NormalizedAgentEvent): Promise<void> {
    if (item.phase === "started" || item.phase === "completed" || item.phase === "failed") return;
    const latest = this.#application.getProjection().agentSessions[base.id] ?? base;
    this.#application.recordAgentSession({
      ...latest,
      phase: item.phase === "blocked" || item.phase === "permission" ? "blocked" : "running",
      lastEvent: item.message,
      updatedAt: item.occurredAt,
    });
  }

  #assertCanDelegate(parentAgentId: string): void {
    const projection = this.#application.getProjection();
    const parent = projection.agents[parentAgentId];
    if (!parent) throw new Error(`parent Agent is not registered: ${parentAgentId}`);
    if (!parent.capabilities.includes("orchestrate-agents")) throw new Error(`Agent cannot orchestrate sub-agents: ${parentAgentId}`);
    const children = Object.values(projection.agents).filter((agent) => agent.parentAgentId === parentAgentId && agent.lifecycle !== "archived");
    const spec = parent.specVersionId ? projection.agentSpecs[parent.specVersionId] : undefined;
    if (children.length >= (spec?.maxFanOut ?? 4)) throw new Error(`Agent fan-out limit reached: ${parentAgentId}`);
    let depth = 0;
    let cursor: AgentProfile | undefined = parent;
    while (cursor?.parentAgentId) {
      depth += 1;
      cursor = projection.agents[cursor.parentAgentId];
    }
    if (depth >= (spec?.maxDelegationDepth ?? 2)) throw new Error(`Agent delegation depth limit reached: ${parentAgentId}`);
  }

  async #workspaceForFlowRun(runId: string): Promise<string> {
    const existing = this.#flowWorkspaces.get(runId);
    if (existing) return existing;
    const pending = this.#flowWorkspaceTasks.get(runId);
    if (pending) return pending;
    const task = this.#createFlowWorkspace(runId).finally(() => this.#flowWorkspaceTasks.delete(runId));
    this.#flowWorkspaceTasks.set(runId, task);
    return task;
  }

  async #createFlowWorkspace(runId: string): Promise<string> {
    const root = join(this.#config.dataDir, "worktrees");
    mkdirSync(root, { recursive: true });
    const path = join(root, slug(runId));
    if (!existsSync(path)) {
      const run = this.#application.getProjection().flowRuns[runId];
      const workspaceId = run?.flowSnapshot?.workspaceId;
      const repositoryPath = workspaceId && this.#config.workspacePath ? await this.#config.workspacePath(workspaceId) : this.#config.repositoryPath;
      const baseline = await runChecked("git", ["rev-parse", "HEAD"], { cwd: repositoryPath });
      await runChecked("git", ["worktree", "add", "-b", `mycel/${slug(runId)}`, path, baseline], { cwd: repositoryPath, timeoutMs: 60_000 });
    }
    this.#flowWorkspaces.set(runId, path);
    return path;
  }

  async #changedFileArtifacts(workspace: string, stepRunId: string): Promise<StepArtifactRef[]> {
    const [tracked, untracked] = await Promise.all([
      runChecked("git", ["diff", "--name-only", "-z", "HEAD"], { cwd: workspace }),
      runChecked("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: workspace }),
    ]);
    const root = realpathSync(workspace);
    const paths = unique([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean));
    return paths.flatMap((path): StepArtifactRef[] => {
      try {
        const target = join(root, path);
        if (!existsSync(target)) return [];
        const realTarget = realpathSync(target);
        const inside = realTarget === root || (realTarget.startsWith(root) && realTarget[root.length] === sep);
        const targetStat = statSync(realTarget);
        if (!inside || !targetStat.isFile() || targetStat.size > 10 * 1024 * 1024) return [];
        const bytes = readFileSync(realTarget);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const artifactPath = relative(root, realTarget);
        return [{
          artifactId: `artifact:step:${slug(stepRunId)}:${sha256.slice(0, 16)}`,
          uri: realTarget,
          mediaType: mediaTypeFor(artifactPath),
          sha256,
          summary: artifactPath,
        }];
      } catch {
        return [];
      }
    });
  }

  #writeRawSession(sessionId: string, result: AgentRunResult): void {
    const directory = join(this.#config.dataDir, "sessions");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${slug(sessionId)}.json`);
    writeFileSync(path, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

function workerCapabilities(spec: WorkerSpecVersion): string[] {
  return unique([
    spec.engine.adapter,
    ...spec.skills.filter((skill) => skill.enabled).map((skill) => `skill:${skill.name}`),
    ...spec.tools.filter((tool) => tool.enabled).map((tool) => tool.name),
    ...spec.mcpServers.filter((server) => server.enabled).map((server) => `mcp:${server.name}`),
    ...(spec.orchestration.enabled ? ["orchestrate-workers"] : []),
  ]);
}

function defaultWorkerSpec(workerId: string, adapter: "claude-code" | "codex", createdAt: string, overrides: { systemPrompt?: string; tools?: string[]; orchestration?: boolean } = {}): WorkerSpecVersion {
  const toolNames = overrides.tools ?? (adapter === "claude-code" ? ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] : ["codex"]);
  return WorkerSpecVersionSchema.parse({
    schemaVersion: 2,
    id: `worker-spec:${workerId}:v1`,
    workerId,
    version: 1,
    engine: { adapter },
    systemPrompt: overrides.systemPrompt ?? "Complete the assigned Mycel Task inside the captured Workspace and permission ceiling. Report concise results and verifiable evidence.",
    skills: [],
    mcpServers: [],
    tools: toolNames.map((name) => ({ name, source: name === "codex" ? "cli" : "builtin", permission: ["Read", "Glob", "Grep"].includes(name) ? "read" : ["Edit", "Write"].includes(name) ? "write" : "execute", enabled: true })),
    fileRefs: [],
    knowledgeRefs: [],
    memory: { scope: "session", resume: true, summaryPolicy: "final" },
    sessionPolicy: { maxTurns: 30, timeoutMs: 30 * 60_000, maxConcurrentSessions: 1 },
    budget: { maxCostUsd: 3 },
    orchestration: { enabled: overrides.orchestration ?? false, maxDelegationDepth: overrides.orchestration ? 2 : 0, maxFanOut: overrides.orchestration ? 4 : 0, allowedWorkerKinds: overrides.orchestration ? ["claude-code", "codex"] : [] },
    lifecycle: "persistent",
    createdBy: overrides.orchestration ? "system:steward-bootstrap" : "system:worker-registry",
    createdAt,
  });
}

function workerProfileFromAgent(profile: AgentProfile, spec: WorkerSpecVersion, controlCapabilities: WorkerProfile["controlCapabilities"]): WorkerProfile {
  return {
    schemaVersion: 2,
    id: profile.id,
    name: profile.name,
    source: profile.source === "graph-native" ? "native" : "adopted",
    adapterKind: profile.adapterKind,
    status: profile.status,
    ...(profile.version ? { version: profile.version } : {}),
    capabilities: workerCapabilities(spec),
    contractLevel: profile.contractLevel,
    ...(profile.connectionUri ? { connectionUri: profile.connectionUri } : {}),
    lifecycle: spec.lifecycle,
    defaultSpecVersionId: spec.id,
    maxConcurrentSessions: spec.sessionPolicy.maxConcurrentSessions,
    controlCapabilities,
    registeredAt: profile.registeredAt,
    updatedAt: profile.updatedAt,
  };
}

function renderHarness(spec: AgentSpec): string {
  return [
    spec.prompt,
    spec.skills.length ? `Skills: ${spec.skills.join(", ")}` : "",
    spec.fileRefs.length ? `Authorized file references: ${spec.fileRefs.join(", ")}` : "",
    spec.canOrchestrate ? `You may propose or create bounded sub-agents up to depth ${spec.maxDelegationDepth} and fan-out ${spec.maxFanOut}.` : "You may not create sub-agents.",
    "Operate only inside the assigned Mycel Work and permission ceiling. Report status and evidence clearly.",
  ].filter(Boolean).join("\n");
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function unique(values: string[]): string[] { return [...new Set(values)]; }

function parseStructuredOutput(summary: string): unknown {
  const trimmed = summary.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed) as unknown; } catch { /* retain text */ }
  }
  return { text: summary };
}

function mediaTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".mdx") return "text/markdown";
  if (extension === ".json") return "application/json";
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html", ".py", ".go", ".rs", ".java", ".sh", ".yaml", ".yml", ".toml", ".txt", ".csv"].includes(extension)) return "text/plain";
  return "application/octet-stream";
}
