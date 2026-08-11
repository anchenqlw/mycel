import { existsSync } from "node:fs";
import { join } from "node:path";
import { ApplicationService, ControlPlane as StewardControlPlane, DelegatingNotifier, TaskService, emptyProjection, reduceProjection, type ControlPlaneHandlers } from "@mycel/application";
import { ClaudeCodeExecutor } from "@mycel/executor-claude-code";
import { SqliteEventStore } from "@mycel/ledger-sqlite";
import { ClaudeSteward } from "@mycel/steward-claude";
import { WorkspaceFilesService } from "@mycel/workspace-files";
import { ControlPlaneService } from "./control-plane.js";
import type { ServerConfig } from "./config.js";
import { ConnectionManager } from "./connections.js";
import { IntentProgressHub } from "./intent-progress.js";
import { type ChangeOperation, type ControlCommand, type ControlResourceReference, type WeaveOperation, type WorkerProfile, type WorkerSpecVersion } from "@mycel/domain";
import {
  materializeCreateFlow,
  materializeUpdateFlow,
  materializeGraphEdge,
  materializeGraphNode,
  resolveFlowTarget,
  validateMaterializableChange,
  type ChangeMaterializationContext,
} from "./change-operation-materializer.js";

export interface MycelRuntime {
  application: ApplicationService;
  control: ControlPlaneService;
  files: WorkspaceFilesService;
  connections: ConnectionManager;
  intentProgress: IntentProgressHub;
  tasks: TaskService;
  stewardControl: StewardControlPlane;
  stop(): void;
}

export async function createRuntime(config: ServerConfig): Promise<MycelRuntime> {
  if (!existsSync(config.repositoryPath)) {
    throw new Error(`target repository does not exist: ${config.repositoryPath}; run npm run demo:reset or set MYCEL_TARGET_REPO`);
  }
  const store = new SqliteEventStore(join(config.dataDir, "ledger.sqlite"), emptyProjection(), reduceProjection);
  const notifier = new DelegatingNotifier();
  const steward = new ClaudeSteward({
    claudeBin: config.claudeBin,
    repositoryPath: config.repositoryPath,
    timeoutMs: config.steward.timeoutMs,
    maxTurns: config.steward.maxTurns,
    maxBudgetUsd: config.steward.maxBudgetUsd,
    ...(config.claudeModel ? { model: config.claudeModel } : {}),
  });
  const executor = new ClaudeCodeExecutor({
    claudeBin: config.claudeBin,
    repositoryPath: config.repositoryPath,
    dataDir: config.dataDir,
    timeoutMs: config.executor.timeoutMs,
    maxTurns: config.executor.maxTurns,
    maxBudgetUsd: config.executor.maxBudgetUsd,
    ...(config.claudeModel ? { model: config.claudeModel } : {}),
  });
  const application = new ApplicationService(store, steward, executor, {
    repositoryId: config.repositoryPath,
    executorActorId: "agent:claude",
    ownerActorId: "human:owner",
    stewardActorId: "agent:steward",
    testCommandId: "cap:test",
    testCommandArgv: config.testCommandArgv,
  }, notifier);
  await application.initialize();
  const files = new WorkspaceFilesService({ repositoryPath: config.repositoryPath, dataDir: config.dataDir });
  const control = new ControlPlaneService(application, {
    repositoryPath: config.repositoryPath,
    dataDir: config.dataDir,
    maxTurns: config.executor.maxTurns,
    maxBudgetUsd: config.executor.maxBudgetUsd,
    workspacePath: async (workspaceId) => (await files.registry.get(workspaceId)).realPath,
    ...(config.claudeModel ? { claudeModel: config.claudeModel } : {}),
  });
  await control.initialize();
  const intentProgress = new IntentProgressHub();
  const tasks = new TaskService(store);
  control.setWorkerSessionObserver(async (session, result) => {
    if (!session.attemptId) return;
    const context = { actorId: session.workerId, idempotencyKey: `worker-session-terminal:${session.id}` };
    if (result.success) {
      tasks.completeAttempt(session.attemptId, { summary: result.summary, evidenceIds: [`worker-session:${session.id}`] }, context);
    } else {
      tasks.failAttempt(session.attemptId, result.stderr.trim() || result.summary, context);
    }
  });
  const stewardControl = new StewardControlPlane(store, controlHandlers(control, tasks, files));
  application.setStewardControlPlane(stewardControl);

  const connections = new ConnectionManager(application, control, notifier, {
    dataDir: config.dataDir,
    debugDingTalk: config.dingtalk?.debug ?? false,
    fakeConnections: config.fakeConnections,
    ...(config.dingtalk ? { legacyDingTalk: config.dingtalk } : {}),
  });
  await connections.initialize();

  return {
    application,
    control,
    files,
    connections,
    intentProgress,
    tasks,
    stewardControl,
    stop: () => { control.stop(); connections.stop(); },
  };
}

function controlHandlers(control: ControlPlaneService, tasks: TaskService, files: WorkspaceFilesService): ControlPlaneHandlers {
  return {
    executeCommand: async (command) => executeControlCommand(command, control, tasks, files),
    validateChange: async (operation, changeSet) => validateMaterializableChange(operation, await materializationContext(changeSet.id, control, files, changeSet.operations), changeSet.operations),
    applyChange: async (operation, changeSet, appliedResults) => applyControlChange(operation, changeSet, appliedResults, control, tasks, files),
    resolveResource: async (resource) => resolveHostResource(resource, files),
  };
}

async function resolveHostResource(resource: ControlResourceReference, files: WorkspaceFilesService): Promise<ControlResourceReference | undefined> {
  if (resource.kind !== "workspace") return undefined;
  try {
    const workspace = await files.registry.get(resource.id);
    return { kind: "workspace", id: workspace.id, label: workspace.name };
  } catch {
    return undefined;
  }
}

async function executeControlCommand(command: ControlCommand, control: ControlPlaneService, tasks: TaskService, files: WorkspaceFilesService): Promise<unknown> {
  const context = { actorId: command.initiatedBy, idempotencyKey: command.idempotencyKey, ...(command.expectedVersion !== undefined ? { expectedVersion: command.expectedVersion } : {}) };
  switch (command.action) {
    case "open-resource": return command.target;
    case "trigger-flow": return control.flowEngine.trigger(command.target.id);
    case "pause-flow": return control.flowEngine.pause(command.target.id);
    case "resume-flow": throw new Error("Flow definitions resume by publishing or unpausing a validated version");
    case "retire-flow": throw new Error("Retiring a Flow is a durable ChangeSet operation");
    case "resume-flow-run": return control.flowEngine.resume(command.target.id);
    case "cancel-flow-run": return control.flowEngine.cancel(command.target.id);
    case "retry-flow-run": return control.flowEngine.retryStep(requiredString(command.arguments.stepRunId, "stepRunId"));
    case "pause-flow-run": throw new Error("This Flow runtime does not support pause; cancel or let active Steps finish");
    case "start-task": return tasks.start(command.target.id, { workerId: requiredString(command.arguments.workerId, "workerId"), ...(optionalString(command.arguments.workerSpecVersionId) ? { workerSpecVersionId: optionalString(command.arguments.workerSpecVersionId)! } : {}) }, context);
    case "pause-task": return tasks.pause(command.target.id, context);
    case "resume-task": return tasks.resume(command.target.id, context);
    case "cancel-task": return tasks.cancel(command.target.id, context);
    case "accept-task": return tasks.accept(command.target.id, context);
    case "retry-task": return tasks.retry(command.target.id, context);
    case "reassign-task": return tasks.replaceWorker(command.target.id, requiredString(command.arguments.workerId, "workerId"), context);
    case "cancel-worker-session": return control.cancelWorkerSession(command.target.id);
    case "resume-worker-session":
    case "send-worker-session":
    case "fork-worker-session": {
      const workspace = await files.registry.get(requiredString(command.arguments.workspaceId, "workspaceId"));
      return control.resumeWorkerSession(command.target.id, requiredString(command.arguments.instruction, "instruction"), { workspaceId: workspace.id, cwd: workspace.realPath, ...(command.action === "fork-worker-session" ? { fork: true } : {}) });
    }
    case "retry-worker-session": {
      const workspace = await files.registry.get(requiredString(command.arguments.workspaceId, "workspaceId"));
      return control.retryWorkerSession(command.target.id, { workspaceId: workspace.id, cwd: workspace.realPath, ...(optionalString(command.arguments.instruction) ? { instruction: optionalString(command.arguments.instruction)! } : {}) });
    }
    case "interrupt-worker-session": return control.cancelWorkerSession(command.target.id);
    case "replace-worker": return tasks.replaceWorker(requiredString(command.arguments.taskId, "taskId"), requiredString(command.arguments.workerId, "workerId"), context);
    case "claim-human-task": return control.flowEngine.claimHumanTask(command.target.id, command.initiatedBy, command.idempotencyKey);
    case "release-human-task": return control.flowEngine.releaseHumanTask(command.target.id, command.initiatedBy, command.idempotencyKey);
    case "reassign-human-task": return control.flowEngine.reassignHumanTask(command.target.id, command.initiatedBy, requiredString(command.arguments.assignedActorId, "assignedActorId"), command.idempotencyKey);
    case "complete-human-task": return control.flowEngine.completeHumanTask(command.target.id, command.initiatedBy, { summary: requiredString(command.arguments.summary, "summary"), ...(command.arguments.output !== undefined ? { output: command.arguments.output } : {}) }, command.idempotencyKey);
    case "reject-human-task": return control.flowEngine.failHumanTask(command.target.id, command.initiatedBy, requiredString(command.arguments.reason, "reason"), command.idempotencyKey);
  }
}

async function applyControlChange(operation: ChangeOperation, changeSet: Parameters<NonNullable<ControlPlaneHandlers["applyChange"]>>[1], appliedResults: Readonly<Record<string, unknown>>, control: ControlPlaneService, tasks: TaskService, files: WorkspaceFilesService): Promise<unknown> {
  const actorId = "agent:steward";
  const changeSetId = changeSet.id;
  const idempotencyKey = `change:${changeSetId}:${operation.id}`;
  const context = await materializationContext(changeSetId, control, files, changeSet.operations, appliedResults);
  switch (operation.kind) {
    case "create-worker": return control.createNativeWorker(operation.payload as unknown as Parameters<ControlPlaneService["createNativeWorker"]>[0]);
    case "update-worker": return control.updateWorker(operation.targetId ?? requiredString(operation.payload.workerId, "workerId"), (operation.payload.patch ?? operation.payload) as Parameters<ControlPlaneService["updateWorker"]>[1]);
    case "archive-worker": return control.archiveWorker(operation.targetId ?? requiredString(operation.payload.workerId, "workerId"));
    case "publish-worker-spec": return control.publishWorkerSpec(resolveResourceId(operation.targetId ?? operation.payload.workerId ?? operation.payload.workerRef, appliedResults, "workerId"), (operation.payload.spec ?? operation.payload) as unknown as Omit<WorkerSpecVersion, "schemaVersion" | "id" | "workerId" | "version" | "createdAt">);
    case "create-flow": return control.saveFlow(materializeCreateFlow(operation, context));
    case "update-flow": return control.saveFlow(materializeUpdateFlow(operation, context));
    case "publish-flow": return control.flowEngine.publish(resolveFlowTarget(operation, appliedResults));
    case "archive-flow": return control.flowEngine.pause(operation.targetId ?? requiredString(operation.payload.flowId, "flowId"));
    case "create-task": return tasks.create(operation.payload as unknown as Parameters<TaskService["create"]>[0], { actorId, idempotencyKey });
    case "update-task": return tasks.updateDefinition(operation.targetId ?? requiredString(operation.payload.taskId, "taskId"), (operation.payload.patch ?? operation.payload) as Parameters<TaskService["updateDefinition"]>[1], { actorId, idempotencyKey, ...(operation.expectedVersion ? { expectedVersion: operation.expectedVersion } : {}) });
    case "create-graph-node": return applyGraphOperation(control, graphNodeOperation(operation, context), idempotencyKey, actorId);
    case "update-graph-node": return applyGraphOperation(control, { operationId: operation.id, op: "update_node", explanation: operationExplanation(operation), nodeId: operation.targetId ?? requiredString(operation.payload.nodeId, "nodeId"), patch: (operation.payload.patch ?? operation.payload) as Record<string, unknown> }, idempotencyKey, actorId);
    case "archive-graph-node": return applyGraphOperation(control, { operationId: operation.id, op: "update_node", explanation: operationExplanation(operation), nodeId: operation.targetId ?? requiredString(operation.payload.nodeId, "nodeId"), patch: { archivedAt: new Date().toISOString() } }, idempotencyKey, actorId);
    case "create-graph-edge": {
      const edge = materializeGraphEdge(operation, context, appliedResults);
      const existing = control.getProjection().graph.edges.find((candidate) => candidate.id === edge.id || (candidate.type === edge.type && candidate.from === edge.from && candidate.to === edge.to && candidate.role === edge.role && candidate.permission === edge.permission));
      return existing ?? applyGraphOperation(control, { operationId: operation.id, op: "add_edge", explanation: operationExplanation(operation), edge }, idempotencyKey, actorId);
    }
    case "remove-graph-edge": {
      const edgeId = operation.targetId ?? requiredString(operation.payload.edgeId, "edgeId");
      const existing = control.getProjection().graph.edges.find((edge) => edge.id === edgeId);
      if (!existing) throw new Error(`Graph edge not found: ${edgeId}`);
      return applyGraphOperation(control, { operationId: operation.id, op: "remove_edge", explanation: operationExplanation(operation), edgeId, edgeType: existing.type }, idempotencyKey, actorId);
    }
    default: throw new Error(`Change operation is not implemented by this runtime: ${operation.kind}`);
  }
}

function graphNodeOperation(operation: ChangeOperation, context: ChangeMaterializationContext): WeaveOperation {
  const node = materializeGraphNode(operation, context);
  return { operationId: operation.id, op: "add_node", explanation: operationExplanation(operation), node };
}

async function materializationContext(
  changeSetId: string,
  control: ControlPlaneService,
  files: WorkspaceFilesService,
  operations: readonly ChangeOperation[] = [],
  appliedResults: Readonly<Record<string, unknown>> = {},
): Promise<ChangeMaterializationContext> {
  const actors = new Map<string, { id: string; kind: "human" | "agent" }>();
  for (const node of control.getProjection().graph.nodes) {
    if (node.type !== "actor") continue;
    const actor = { id: node.id, kind: node.kind };
    actors.set(node.id, actor);
  }
  for (const worker of Object.values(control.getProjection().workers)) {
    const actor = { id: worker.id, kind: "agent" as const };
    actors.set(worker.id, actor);
  }
  for (const operation of operations) {
    if (operation.kind !== "create-worker") continue;
    const pending = { id: `pending:${operation.id}`, kind: "agent" as const };
    actors.set(operation.id, pending);
  }
  for (const [operationId, value] of Object.entries(appliedResults)) {
    if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") continue;
    const sourceOperation = operations.find((candidate) => candidate.id === operationId);
    if (sourceOperation?.kind !== "create-worker") continue;
    const actor = { id: value.id, kind: "agent" as const };
    actors.set(operationId, actor);
  }

  const workspaces = new Map<string, string>();
  for (const workspace of await files.registry.list()) {
    workspaces.set(workspace.id, workspace.id);
  }
  const flows = new Map(control.flowEngine.list().map((flow) => [flow.id, flow]));
  const graphNodeIds = new Set(control.getProjection().graph.nodes.map((node) => node.id));
  return { changeSetId, now: new Date().toISOString(), actors, workspaces, flows, graphNodeIds };
}

function applyGraphOperation(control: ControlPlaneService, operation: WeaveOperation, idempotencyKey: string, actorId: string): unknown {
  const graph = control.applyGraphOperations([operation], idempotencyKey, actorId).graph;
  switch (operation.op) {
    case "add_node": return graph.nodes.find((node) => node.id === operation.node.id) ?? operation.node;
    case "update_node": return graph.nodes.find((node) => node.id === operation.nodeId) ?? { id: operation.nodeId };
    case "add_edge": return graph.edges.find((edge) => edge.id === operation.edge.id) ?? operation.edge;
    case "remove_edge": return { id: operation.edgeId, removed: true };
  }
}

function resolveResourceId(value: unknown, appliedResults: Readonly<Record<string, unknown>>, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  const referenced = appliedResults[value];
  if (!referenced) return value;
  if (typeof referenced === "object" && referenced !== null && "id" in referenced && typeof referenced.id === "string") return referenced.id;
  throw new Error(`Operation reference ${value} did not produce a resource ID`);
}

function operationExplanation(operation: ChangeOperation): string {
  return optionalString(operation.payload.explanation) ?? `${operation.kind} from ChangeSet`;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
