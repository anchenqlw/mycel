import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { ulid } from "ulid";
import Fastify from "fastify";
import { z } from "zod";
import { ChangeSetSchema, ControlCommandSchema, sanitizeForPresentation, WorkerSpecVersionSchema } from "@mycel/domain";
import type { MycelRuntime } from "./runtime.js";
import { pickLocalDirectory } from "./pick-directory.js";

const IntentSchema = z.object({ text: z.string().trim().min(1).max(20_000), requestId: z.string().min(1).max(200).optional(), workspaceId: z.string().min(1).optional(), timezone: z.string().min(1).max(200).optional() });
const RegisterWorkspaceSchema = z.object({ path: z.string().trim().min(1).max(4_000), name: z.string().trim().min(1).max(120).optional() });
const WorkspaceConversationSchema = z.object({ conversationId: z.string().min(1).default("web:local-owner") });
const WorkspaceRemoteSchema = z.object({ url: z.string().trim().min(1).max(2_000), overwrite: z.boolean().default(false) });
const ActionSchema = z.object({
  action: z.enum(["approve", "reject", "revise", "cancel", "accept", "reject_acceptance", "approve_proposal", "reject_proposal"]),
  aggregateId: z.string().min(1),
  reason: z.string().max(2_000).optional(),
});
const ComposeAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  engine: z.enum(["claude-code", "codex"]),
  prompt: z.string().trim().min(1).max(20_000),
  skills: z.array(z.string().min(1)).max(50).optional(),
  tools: z.array(z.string().min(1)).max(50).optional(),
  fileRefs: z.array(z.string().min(1)).max(100).optional(),
  lifecycle: z.enum(["run-scoped", "flow-scoped", "persistent"]).optional(),
  canOrchestrate: z.boolean().optional(),
  parentAgentId: z.string().min(1).optional(),
  subgraphId: z.string().min(1).optional(),
});
const RegisterAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapterKind: z.enum(["mcp", "a2a"]),
  connectionUri: z.string().url(),
  capabilities: z.array(z.string().min(1)).max(50).optional(),
  contractLevel: z.enum(["status", "results", "evidence", "control"]).optional(),
});
const ExternalDiscoverySchema = z.object({
  protocol: z.enum(["mcp", "a2a"]),
  endpoint: z.string().url(),
  bearerToken: z.string().max(8_000).optional(),
  contractLevel: z.enum(["status", "results", "evidence", "control"]).optional(),
});
const ManualDingTalkSchema = z.object({
  clientId: z.string().trim().min(1),
  clientSecret: z.string().trim().min(1),
  allowedUserIds: z.array(z.string().trim().min(1)).default([]),
  robotCode: z.string().trim().optional(),
  cardTemplateId: z.string().trim().optional(),
});
const ManualFeishuSchema = z.object({
  appId: z.string().trim().min(1),
  appSecret: z.string().trim().min(1),
  allowedOpenIds: z.array(z.string().trim().min(1)).default([]),
});
const StartSessionSchema = z.object({
  agentId: z.string().min(1),
  prompt: z.string().trim().min(1).max(20_000),
  mode: z.enum(["explore", "execute"]).default("explore"),
  workId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});
const WorkerSpecDraftSchema = WorkerSpecVersionSchema.omit({ schemaVersion: true, id: true, workerId: true, version: true, createdAt: true });
const CreateWorkerSchema = z.object({ name: z.string().trim().min(1).max(120), spec: WorkerSpecDraftSchema });
const StartWorkerSessionSchema = z.object({
  workerId: z.string().min(1), instruction: z.string().trim().min(1).max(20_000), mode: z.enum(["explore", "execute"]).default("explore"),
  workspaceId: z.string().min(1).optional(), taskId: z.string().min(1).optional(), attemptId: z.string().min(1).optional(),
  workId: z.string().min(1).optional(), flowRunId: z.string().min(1).optional(), permissionLeaseId: z.string().min(1).optional(), workerSpecVersionId: z.string().min(1).optional(),
});
const ContinueWorkerSessionSchema = z.object({ instruction: z.string().trim().min(1).max(20_000), workspaceId: z.string().min(1).optional() });
const CreateTaskSchema = z.object({
  id: z.string().min(1).optional(), title: z.string().trim().min(1).max(240), description: z.string().max(20_000).default(""),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("conversation"), conversationId: z.string().min(1) }),
    z.object({ kind: z.literal("flow"), flowId: z.string().min(1), flowRunId: z.string().min(1), stepId: z.string().min(1) }),
    z.object({ kind: z.literal("graph"), workId: z.string().min(1) }),
  ]).default({ kind: "conversation", conversationId: "web:local-owner" }),
  initiatorActorId: z.string().min(1).default("human:owner"), ownerActorId: z.string().min(1).default("human:owner"),
  candidateWorkerIds: z.array(z.string()).default([]), humanActorIds: z.array(z.string()).default(["human:owner"]), workspaceId: z.string().min(1),
  permissionCeiling: z.array(z.string()).default(["repository-read"]), acceptanceCriteria: z.array(z.string().min(1)).min(1),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  budget: z.object({ maxAttempts: z.number().int().positive().default(3), maxRuntimeMs: z.number().int().positive().default(30 * 60_000), maxCostUsd: z.number().nonnegative().optional() }).default({ maxAttempts: 3, maxRuntimeMs: 30 * 60_000 }),
  dueAt: z.string().datetime().optional(),
});
const TaskContextSchema = z.object({ expectedVersion: z.number().int().positive(), actorId: z.string().min(1).default("human:owner") });
const StartTaskSchema = TaskContextSchema.extend({ workerId: z.string().min(1), instruction: z.string().trim().min(1).max(20_000), mode: z.enum(["explore", "execute"]).default("explore"), workspaceId: z.string().min(1).optional(), workerSpecVersionId: z.string().min(1).optional() });
const FlowStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["agent", "human"]),
  actorId: z.string().min(1),
  prompt: z.string(),
  dependsOn: z.array(z.string()),
  condition: z.enum(["always", "previous-succeeded", "previous-failed"]),
  timeoutMs: z.number().int().min(1_000).max(7 * 24 * 60 * 60_000),
  maxAttempts: z.number().int().min(1).max(10),
  join: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("all") }),
    z.object({ mode: z.literal("any") }),
    z.object({ mode: z.literal("race") }),
    z.object({ mode: z.literal("quorum"), quorum: z.number().int().positive() }),
  ]).default({ mode: "all" }),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
});
const FlowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("schedule"), intervalMs: z.number().int().min(10_000) }),
  z.object({ kind: z.literal("graph-event"), eventType: z.string().min(1) }),
  z.object({ kind: z.literal("file-change"), glob: z.string().min(1) }),
  z.object({ kind: z.literal("webhook"), key: z.string().min(1) }),
]);
const SaveFlowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  status: z.enum(["draft", "published", "paused", "retired"]).default("draft"),
  version: z.number().int().nonnegative().default(0),
  trigger: FlowTriggerSchema,
  steps: z.array(FlowStepSchema).min(1),
  permissionCeiling: z.array(z.string()),
  maxConcurrency: z.number().int().min(1).max(32).default(4),
  budget: z.object({
    maxRuntimeMs: z.number().int().min(1_000).max(24 * 60 * 60_000),
    maxTotalAttempts: z.number().int().min(1).max(1_000),
    maxCostUsd: z.number().positive().optional(),
  }).default({ maxRuntimeMs: 30 * 60_000, maxTotalAttempts: 100 }),
});
const HumanTaskCompleteSchema = z.object({
  actorId: z.string().min(1).default("human:owner"),
  summary: z.string().trim().min(1).max(20_000),
  output: z.unknown().optional(),
  files: z.array(z.object({ workspaceId: z.string().min(1), path: z.string().min(1), summary: z.string().max(1_000).optional() })).max(50).default([]),
});

export async function buildServer(runtime: MycelRuntime) {
  const server = Fastify({ logger: true });

  server.get("/api/health", async () => {
    const connections = runtime.connections.snapshot().im;
    return { ok: true, dingtalk: connections.dingtalk.phase === "connected", feishu: connections.feishu.phase === "connected" };
  });
  server.get("/api/connections", async () => runtime.connections.snapshot());
  server.post("/api/connections/dingtalk/reconnect", async () => runtime.connections.reconnectDingTalk());
  server.post("/api/connections/dingtalk/disconnect", async (request) => {
    const { deleteCredentials } = z.object({ deleteCredentials: z.boolean().default(false) }).parse(request.body ?? {});
    return runtime.connections.disconnectDingTalk(deleteCredentials);
  });
  server.post("/api/connections/dingtalk/manual", async (request) => {
    const input = ManualDingTalkSchema.parse(request.body);
    return runtime.connections.configureDingTalkManually({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      allowedUserIds: input.allowedUserIds,
      ...(input.robotCode ? { robotCode: input.robotCode } : {}),
      ...(input.cardTemplateId ? { cardTemplateId: input.cardTemplateId } : {}),
    });
  });
  server.post("/api/connections/feishu/qr", async (_request, reply) => reply.code(202).send(await runtime.connections.beginFeishuQr()));
  server.post("/api/connections/feishu/qr/:sessionId/cancel", async (request) => {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    return runtime.connections.cancelFeishuQr(sessionId);
  });
  server.post("/api/connections/feishu/reconnect", async () => runtime.connections.reconnectFeishu());
  server.post("/api/connections/feishu/disconnect", async (request) => {
    const { deleteCredentials } = z.object({ deleteCredentials: z.boolean().default(false) }).parse(request.body ?? {});
    return runtime.connections.disconnectFeishu(deleteCredentials);
  });
  server.post("/api/connections/feishu/manual", async (request) => {
    const input = ManualFeishuSchema.parse(request.body);
    return runtime.connections.configureFeishuManually(input);
  });
  server.post("/api/agent-discovery/local/scan", async () => runtime.connections.scanLocalAgents());
  server.post("/api/agent-discovery/local/:candidateId/adopt", async (request, reply) => {
    const { candidateId } = z.object({ candidateId: z.string().min(1) }).parse(request.params);
    return reply.code(201).send(await runtime.connections.adoptLocalAgent(candidateId));
  });
  server.post("/api/agent-discovery/external", async (request, reply) => {
    const input = ExternalDiscoverySchema.parse(request.body);
    return reply.code(202).send(await runtime.connections.discoverExternalAgent({
      protocol: input.protocol,
      endpoint: input.endpoint,
      ...(input.bearerToken ? { bearerToken: input.bearerToken } : {}),
      ...(input.contractLevel ? { contractLevel: input.contractLevel } : {}),
    }));
  });
  server.post("/api/agent-discovery/:attemptId/adopt", async (request, reply) => {
    const { attemptId } = z.object({ attemptId: z.string().min(1) }).parse(request.params);
    const { displayName } = z.object({ displayName: z.string().trim().max(120).optional() }).parse(request.body ?? {});
    return reply.code(201).send(runtime.connections.adoptExternalAgent(attemptId, displayName));
  });
  server.get("/api/state", async () => runtime.application.getProjection());
  server.get("/api/ledger", async (request) => {
    const query = z.object({ correlationId: z.string().optional() }).parse(request.query);
    return runtime.application.readLedger(query.correlationId);
  });
  server.get("/api/history", async (request) => {
    const query = z.object({
      actorId: z.string().optional(),
      aggregateId: z.string().optional(),
      eventType: z.string().optional(),
      correlationId: z.string().optional(),
      flowRunId: z.string().optional(),
      stepRunId: z.string().optional(),
      humanTaskId: z.string().optional(),
    }).parse(request.query);
    return runtime.application.readLedger(query.correlationId).filter((event) =>
      (!query.actorId || event.actorId === query.actorId)
      && (!query.aggregateId || event.aggregateId === query.aggregateId)
      && (!query.eventType || event.eventType === query.eventType)
      && matchesRuntimeReference(event, "flowRunId", query.flowRunId)
      && matchesRuntimeReference(event, "stepRunId", query.stepRunId)
      && matchesRuntimeReference(event, "humanTaskId", query.humanTaskId))
      .map((event) => ({ ...event, payload: sanitizeForPresentation(event.payload) }));
  });
  server.get("/api/agents", async () => Object.values(runtime.application.getProjection().agents ?? {}));
  server.get("/api/workers", async () => Object.values(runtime.application.getProjection().workers ?? {}));
  server.get("/api/worker-specs", async (request) => {
    const { workerId } = z.object({ workerId: z.string().optional() }).parse(request.query);
    return Object.values(runtime.application.getProjection().workerSpecs ?? {}).filter((spec) => !workerId || spec.workerId === workerId);
  });
  server.get("/api/worker-secrets", async () => runtime.control.workerSecretRefs().map((secretRef) => ({ secretRef, configured: true })));
  server.put("/api/worker-secrets/:secretRef", async (request, reply) => {
    const { secretRef } = z.object({ secretRef: z.string().min(1) }).parse(request.params);
    const { value } = z.object({ value: z.string().min(1).max(32_000) }).parse(request.body);
    return reply.code(204).send(runtime.control.configureWorkerSecret(secretRef, value));
  });
  server.delete("/api/worker-secrets/:secretRef", async (request) => {
    const { secretRef } = z.object({ secretRef: z.string().min(1) }).parse(request.params);
    return runtime.control.deleteWorkerSecret(secretRef);
  });
  server.post("/api/workers", async (request, reply) => {
    const input = CreateWorkerSchema.parse(request.body);
    return reply.code(201).send(runtime.control.createNativeWorker(input));
  });
  server.post("/api/workers/:workerId/specs", async (request, reply) => {
    const { workerId } = z.object({ workerId: z.string().min(1) }).parse(request.params);
    const spec = WorkerSpecDraftSchema.parse(request.body);
    return reply.code(201).send(runtime.control.publishWorkerSpec(workerId, spec));
  });
  server.get("/api/worker-sessions", async (request) => {
    const query = z.object({ workerId: z.string().optional(), taskId: z.string().optional(), phase: z.string().optional() }).parse(request.query);
    return Object.values(runtime.application.getProjection().workerSessions ?? {}).filter((session) => (!query.workerId || session.workerId === query.workerId) && (!query.taskId || session.taskId === query.taskId) && (!query.phase || session.phase === query.phase));
  });
  server.post("/api/worker-sessions", async (request, reply) => {
    const input = StartWorkerSessionSchema.parse(request.body);
    const workspace = input.workspaceId ? await runtime.files.registry.get(input.workspaceId) : await runtime.files.registry.selected("web:local-owner");
    return reply.code(202).send(runtime.control.startWorkerSession({
      workerId: input.workerId, instruction: input.instruction, mode: input.mode, workspaceId: workspace.id, cwd: workspace.realPath,
      ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.workId ? { workId: input.workId } : {}), ...(input.flowRunId ? { flowRunId: input.flowRunId } : {}),
      ...(input.permissionLeaseId ? { permissionLeaseId: input.permissionLeaseId } : {}), ...(input.workerSpecVersionId ? { workerSpecVersionId: input.workerSpecVersionId } : {}),
    }));
  });
  server.post("/api/worker-sessions/:sessionId/cancel", async (request) => {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    return runtime.control.cancelWorkerSession(sessionId);
  });
  server.post("/api/worker-sessions/:sessionId/resume", async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const input = ContinueWorkerSessionSchema.parse(request.body);
    const workspace = input.workspaceId ? await runtime.files.registry.get(input.workspaceId) : await runtime.files.registry.selected("web:local-owner");
    return reply.code(202).send(runtime.control.resumeWorkerSession(sessionId, input.instruction, { workspaceId: workspace.id, cwd: workspace.realPath }));
  });
  server.post("/api/worker-sessions/:sessionId/fork", async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const input = ContinueWorkerSessionSchema.parse(request.body);
    const workspace = input.workspaceId ? await runtime.files.registry.get(input.workspaceId) : await runtime.files.registry.selected("web:local-owner");
    return reply.code(202).send(runtime.control.resumeWorkerSession(sessionId, input.instruction, { workspaceId: workspace.id, cwd: workspace.realPath, fork: true }));
  });
  server.post("/api/worker-sessions/:sessionId/retry", async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    const input = z.object({ instruction: z.string().trim().min(1).max(20_000).optional(), workspaceId: z.string().min(1).optional() }).parse(request.body ?? {});
    const workspace = input.workspaceId ? await runtime.files.registry.get(input.workspaceId) : await runtime.files.registry.selected("web:local-owner");
    return reply.code(202).send(runtime.control.retryWorkerSession(sessionId, { workspaceId: workspace.id, cwd: workspace.realPath, ...(input.instruction ? { instruction: input.instruction } : {}) }));
  });
  server.get("/api/tasks", async (request) => {
    const query = z.object({ status: z.string().optional(), ownerActorId: z.string().optional(), workspaceId: z.string().optional() }).parse(request.query);
    return Object.values(runtime.application.getProjection().tasks ?? {}).filter((task) => (!query.status || task.status === query.status) && (!query.ownerActorId || task.ownerActorId === query.ownerActorId) && (!query.workspaceId || task.workspaceId === query.workspaceId));
  });
  server.get("/api/tasks/:taskId", async (request, reply) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const task = runtime.application.getProjection().tasks[taskId];
    if (!task) return reply.code(404).send({ error: "Task not found" });
    return { task, attempts: task.attemptIds.map((id) => runtime.application.getProjection().taskAttempts[id]).filter(Boolean), sessions: Object.values(runtime.application.getProjection().workerSessions).filter((session) => session.taskId === taskId) };
  });
  server.post("/api/tasks", async (request, reply) => {
    const input = CreateTaskSchema.parse(request.body);
    const task = runtime.tasks.create({
      ...(input.id ? { id: input.id } : {}), title: input.title, description: input.description, source: input.source,
      initiatorActorId: input.initiatorActorId, ownerActorId: input.ownerActorId, candidateWorkerIds: input.candidateWorkerIds,
      humanActorIds: input.humanActorIds, workspaceId: input.workspaceId, permissionCeiling: input.permissionCeiling,
      acceptanceCriteria: input.acceptanceCriteria, priority: input.priority,
      budget: { maxAttempts: input.budget.maxAttempts, maxRuntimeMs: input.budget.maxRuntimeMs, ...(input.budget.maxCostUsd !== undefined ? { maxCostUsd: input.budget.maxCostUsd } : {}) },
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
    }, { actorId: input.initiatorActorId, idempotencyKey: requestKey(request, `task-create:${input.id ?? input.title}`) });
    return reply.code(201).send(task);
  });
  server.post("/api/tasks/:taskId/start", async (request, reply) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const input = StartTaskSchema.parse(request.body);
    const workspace = input.workspaceId ? await runtime.files.registry.get(input.workspaceId) : await runtime.files.registry.get(runtime.application.getProjection().tasks[taskId]?.workspaceId ?? "repository");
    const started = runtime.tasks.start(taskId, { workerId: input.workerId, ...(input.workerSpecVersionId ? { workerSpecVersionId: input.workerSpecVersionId } : {}) }, { actorId: input.actorId, expectedVersion: input.expectedVersion, idempotencyKey: requestKey(request, `task-start:${taskId}`) });
    const session = runtime.control.startWorkerSession({ workerId: input.workerId, instruction: input.instruction, mode: input.mode, workspaceId: workspace.id, cwd: workspace.realPath, taskId, attemptId: started.attempt.id, ...(input.workerSpecVersionId ? { workerSpecVersionId: input.workerSpecVersionId } : {}) });
    runtime.tasks.linkWorkerSession(started.attempt.id, session.id, { actorId: "system:worker-runtime", idempotencyKey: `task-attempt-session:${started.attempt.id}:${session.id}` });
    return reply.code(202).send({ ...started, session });
  });
  for (const [path, action] of [["pause", "pause"], ["resume", "resume"], ["cancel", "cancel"], ["accept", "accept"]] as const) {
    server.post(`/api/tasks/:taskId/${path}`, async (request) => {
      const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
      const input = TaskContextSchema.parse(request.body);
      return runtime.tasks[action](taskId, { actorId: input.actorId, expectedVersion: input.expectedVersion, idempotencyKey: requestKey(request, `task-${action}:${taskId}`) });
    });
  }
  server.post("/api/tasks/:taskId/retry", async (request) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const input = TaskContextSchema.parse(request.body);
    return runtime.tasks.retry(taskId, { actorId: input.actorId, expectedVersion: input.expectedVersion, idempotencyKey: requestKey(request, `task-retry:${taskId}`) });
  });
  server.post("/api/tasks/:taskId/replace-worker", async (request) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const input = TaskContextSchema.extend({ workerId: z.string().min(1) }).parse(request.body);
    return runtime.tasks.replaceWorker(taskId, input.workerId, { actorId: input.actorId, expectedVersion: input.expectedVersion, idempotencyKey: requestKey(request, `task-replace:${taskId}`) });
  });
  server.post("/api/task-attempts/:attemptId/complete", async (request) => {
    const { attemptId } = z.object({ attemptId: z.string().min(1) }).parse(request.params);
    const input = z.object({ summary: z.string().trim().min(1).max(20_000), evidenceIds: z.array(z.string().min(1)).min(1), actorId: z.string().min(1) }).parse(request.body);
    return runtime.tasks.completeAttempt(attemptId, { summary: input.summary, evidenceIds: input.evidenceIds }, { actorId: input.actorId, idempotencyKey: requestKey(request, `task-attempt-complete:${attemptId}`) });
  });
  server.get("/api/commands", async () => Object.values(runtime.application.getProjection().commands ?? {}));
  server.post("/api/commands", async (request, reply) => reply.code(202).send(await runtime.stewardControl.executeCommand(ControlCommandSchema.parse(request.body))));
  server.get("/api/change-sets", async () => Object.values(runtime.application.getProjection().changeSets ?? {}));
  server.post("/api/change-sets", async (request, reply) => reply.code(201).send(await runtime.stewardControl.proposeChangeSet(ChangeSetSchema.parse(request.body))));
  server.post("/api/change-sets/:changeSetId/approve", async (request) => {
    const { changeSetId } = z.object({ changeSetId: z.string().min(1) }).parse(request.params);
    const { actorId } = z.object({ actorId: z.string().min(1).default("human:owner") }).parse(request.body ?? {});
    return runtime.stewardControl.approveChangeSet(changeSetId, actorId);
  });
  server.post("/api/change-sets/:changeSetId/reject", async (request) => {
    const { changeSetId } = z.object({ changeSetId: z.string().min(1) }).parse(request.params);
    const { actorId } = z.object({ actorId: z.string().min(1).default("human:owner") }).parse(request.body ?? {});
    return runtime.stewardControl.rejectChangeSet(changeSetId, actorId);
  });
  server.post("/api/change-sets/:changeSetId/apply", async (request) => {
    const { changeSetId } = z.object({ changeSetId: z.string().min(1) }).parse(request.params);
    return runtime.stewardControl.applyChangeSet(changeSetId);
  });
  server.post("/api/agents/register", async (request, reply) => {
    RegisterAgentSchema.parse(request.body);
    return reply.code(409).send({ error: "外部 Agent 必须先通过 /api/agent-discovery/external 完成握手和能力发现" });
  });
  server.post("/api/agents/compose", async (request, reply) => {
    const input = ComposeAgentSchema.parse(request.body);
    return reply.code(201).send(runtime.control.composeAgent({
      name: input.name,
      engine: input.engine,
      prompt: input.prompt,
      ...(input.skills ? { skills: input.skills } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.fileRefs ? { fileRefs: input.fileRefs } : {}),
      ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
      ...(input.canOrchestrate !== undefined ? { canOrchestrate: input.canOrchestrate } : {}),
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
      ...(input.subgraphId ? { subgraphId: input.subgraphId } : {}),
    }));
  });
  server.post("/api/agent-sessions", async (request, reply) => {
    const input = StartSessionSchema.parse(request.body);
    const workspace = input.workspaceId ? await runtime.files.registry.get(input.workspaceId) : await runtime.files.registry.selected("web:local-owner");
    return reply.code(202).send(runtime.control.startSession({
      agentId: input.agentId,
      prompt: input.prompt,
      mode: input.mode,
      ...(input.workId ? { workId: input.workId } : {}),
      cwd: workspace.realPath,
    }));
  });
  server.post("/api/agent-sessions/:sessionId/cancel", async (request) => {
    const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.params);
    return { canceled: runtime.control.cancelSession(sessionId) };
  });
  server.post("/api/humans", async (request, reply) => {
    const input = z.object({ id: z.string().min(1), name: z.string().min(1), dingtalkUserId: z.string().min(1).optional() }).parse(request.body);
    return reply.code(201).send(runtime.application.createHumanActor({ id: input.id, name: input.name, ...(input.dingtalkUserId ? { dingtalkUserId: input.dingtalkUserId } : {}) }));
  });
  server.get("/api/flows", async () => Object.values(runtime.application.getProjection().flows ?? {}));
  server.post("/api/flows", async (request, reply) => {
    const input = SaveFlowSchema.parse(request.body);
    const flow = await runtime.control.saveFlow({
      ...input,
      budget: {
        maxRuntimeMs: input.budget.maxRuntimeMs,
        maxTotalAttempts: input.budget.maxTotalAttempts,
        ...(input.budget.maxCostUsd !== undefined ? { maxCostUsd: input.budget.maxCostUsd } : {}),
      },
    });
    return reply.code(201).send(flow);
  });
  server.post("/api/flows/:flowId/publish", async (request) => {
    const { flowId } = z.object({ flowId: z.string().min(1) }).parse(request.params);
    return runtime.control.flowEngine.publish(flowId);
  });
  server.post("/api/flows/:flowId/pause", async (request) => {
    const { flowId } = z.object({ flowId: z.string().min(1) }).parse(request.params);
    return runtime.control.flowEngine.pause(flowId);
  });
  server.post("/api/flows/:flowId/trigger", async (request, reply) => {
    const { flowId } = z.object({ flowId: z.string().min(1) }).parse(request.params);
    return reply.code(202).send(await runtime.control.flowEngine.trigger(flowId));
  });
  server.post("/api/flows/:flowId/runs", async (request, reply) => {
    const { flowId } = z.object({ flowId: z.string().min(1) }).parse(request.params);
    return reply.code(202).send(await runtime.control.flowEngine.trigger(flowId));
  });
  server.get("/api/flow-runs/:runId", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    return runtime.control.flowEngine.details(runId);
  });
  server.post("/api/flow-runs/:runId/resume", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    return runtime.control.flowEngine.resume(runId);
  });
  server.post("/api/flow-runs/:runId/cancel", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    return runtime.control.flowEngine.cancel(runId);
  });
  server.post("/api/step-runs/:stepRunId/retry", async (request) => {
    const { stepRunId } = z.object({ stepRunId: z.string().min(1) }).parse(request.params);
    return runtime.control.flowEngine.retryStep(stepRunId);
  });
  server.post("/api/step-runs/:stepRunId/replace-actor", async (request) => {
    const { stepRunId } = z.object({ stepRunId: z.string().min(1) }).parse(request.params);
    const { actorId } = z.object({ actorId: z.string().min(1) }).parse(request.body);
    return runtime.control.flowEngine.retryStep(stepRunId, actorId);
  });
  server.get("/api/human-tasks", async (request) => {
    const query = z.object({ actorId: z.string().optional(), phase: z.enum(["open", "claimed", "completed", "failed", "cancelled"]).optional() }).parse(request.query);
    return Object.values(runtime.application.getProjection().humanTasks ?? {}).filter((task) =>
      (!query.actorId || task.assignedActorId === query.actorId || task.claimedByActorId === query.actorId)
      && (!query.phase || task.phase === query.phase));
  });
  server.post("/api/human-tasks/:taskId/claim", async (request) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const { actorId } = z.object({ actorId: z.string().min(1).default("human:owner") }).parse(request.body ?? {});
    return runtime.control.flowEngine.claimHumanTask(taskId, actorId, requestKey(request, `claim:${taskId}`));
  });
  server.post("/api/human-tasks/:taskId/release", async (request) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const { actorId } = z.object({ actorId: z.string().min(1).default("human:owner") }).parse(request.body ?? {});
    return runtime.control.flowEngine.releaseHumanTask(taskId, actorId, requestKey(request, `release:${taskId}`));
  });
  server.post("/api/human-tasks/:taskId/reassign", async (request) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const body = z.object({ actorId: z.string().min(1).default("human:owner"), assignedActorId: z.string().min(1) }).parse(request.body);
    return runtime.control.flowEngine.reassignHumanTask(taskId, body.actorId, body.assignedActorId, requestKey(request, `reassign:${taskId}`));
  });
  server.post("/api/human-tasks/:taskId/complete", async (request) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const body = HumanTaskCompleteSchema.parse(request.body);
    const artifacts = await Promise.all(body.files.map(async (file) => {
      const item = await runtime.files.artifact(file.workspaceId, file.path);
      return { artifactId: `artifact:file:${item.sha256}`, uri: item.absolutePath, mediaType: item.mediaType, sha256: item.sha256, summary: file.summary ?? item.name };
    }));
    return runtime.control.flowEngine.completeHumanTask(taskId, body.actorId, { summary: body.summary, ...(body.output !== undefined ? { output: body.output } : {}), artifacts }, requestKey(request, `complete:${taskId}`));
  });
  server.post("/api/human-tasks/:taskId/fail", async (request) => {
    const { taskId } = z.object({ taskId: z.string().min(1) }).parse(request.params);
    const body = z.object({ actorId: z.string().min(1).default("human:owner"), reason: z.string().trim().min(1).max(2_000) }).parse(request.body);
    return runtime.control.flowEngine.failHumanTask(taskId, body.actorId, body.reason, requestKey(request, `fail:${taskId}`));
  });
  server.get("/api/flow-runs/:runId/permission-leases", async (request) => {
    const { runId } = z.object({ runId: z.string().min(1) }).parse(request.params);
    return Object.values(runtime.application.getProjection().permissionLeases ?? {}).filter((lease) => lease.flowRunId === runId);
  });
  server.post("/api/permission-requests/:requestId/approve", async (request) => {
    const { requestId } = z.object({ requestId: z.string().min(1) }).parse(request.params);
    const { actorId } = z.object({ actorId: z.string().min(1).default("human:owner") }).parse(request.body ?? {});
    return runtime.control.flowEngine.approvePermissionRequest(requestId, actorId, requestKey(request, `permission-approve:${requestId}`));
  });
  server.post("/api/permission-requests/:requestId/deny", async (request) => {
    const { requestId } = z.object({ requestId: z.string().min(1) }).parse(request.params);
    const body = z.object({ actorId: z.string().min(1).default("human:owner"), reason: z.string().trim().min(1).max(2_000) }).parse(request.body);
    return runtime.control.flowEngine.denyPermissionRequest(requestId, body.actorId, body.reason, requestKey(request, `permission-deny:${requestId}`));
  });
  server.get("/api/workspaces", async () => runtime.files.workspaces());
  server.get("/api/workspaces/selected", async (request) => {
    const { conversationId } = WorkspaceConversationSchema.parse(request.query ?? {});
    return runtime.files.registry.selected(conversationId);
  });
  server.post("/api/workspaces/pick-directory", async (_request, reply) => reply.code(200).send(await pickLocalDirectory()));
  server.post("/api/workspaces", async (request, reply) => {
    const input = RegisterWorkspaceSchema.parse(request.body);
    const result = await runtime.files.registry.register({ path: input.path, ...(input.name ? { name: input.name } : {}) });
    return reply.code(result.created ? 201 : 200).send(result);
  });
  server.patch("/api/workspaces/:workspaceId", async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.string().min(1) }).parse(request.params);
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(request.body);
    return runtime.files.registry.rename(workspaceId, name);
  });
  server.delete("/api/workspaces/:workspaceId", async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.string().min(1) }).parse(request.params);
    return runtime.files.registry.remove(workspaceId);
  });
  server.post("/api/workspaces/:workspaceId/select", async (request) => {
    const { workspaceId } = z.object({ workspaceId: z.string().min(1) }).parse(request.params);
    const { conversationId } = WorkspaceConversationSchema.parse(request.body ?? {});
    return runtime.files.registry.select(conversationId, workspaceId);
  });
  server.put("/api/workspaces/:workspaceId/remote", async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string().min(1) }).parse(request.params);
    const input = WorkspaceRemoteSchema.parse(request.body);
    const result = await runtime.files.registry.configureOrigin(workspaceId, input.url, input.overwrite);
    return reply.code(result.status === "conflict" ? 409 : 200).send(result);
  });
  server.get("/api/files/tree", async (request) => {
    const query = z.object({ workspaceId: z.string().default("repository"), path: z.string().default("") }).parse(request.query);
    return runtime.files.list(query.workspaceId, query.path);
  });
  server.get("/api/files/preview", async (request) => {
    const query = z.object({ workspaceId: z.string().default("repository"), path: z.string().min(1) }).parse(request.query);
    return runtime.files.preview(query.workspaceId, query.path);
  });
  server.post("/api/files/open", async (request) => {
    const input = z.object({ workspaceId: z.string().min(1), path: z.string().min(1) }).parse(request.body);
    return runtime.files.openWithSystem(input.workspaceId, input.path);
  });
  server.get("/api/artifacts/:artifactId", async (request, reply) => {
    const { artifactId } = z.object({ artifactId: z.string().min(1) }).parse(request.params);
    const evidence = runtime.application.getProjection().evidence[artifactId];
    const stepArtifact = Object.values(runtime.application.getProjection().stepResults ?? {}).flatMap((result) => result.artifacts).find((artifact) => artifact.artifactId === artifactId);
    const artifact = evidence ?? stepArtifact;
    if (!artifact || !existsSync(artifact.uri)) return reply.code(404).send({ error: "Artifact not found" });
    return reply.type(artifact.mediaType).send(createReadStream(artifact.uri));
  });
  server.post("/api/intents", async (request, reply) => {
    const body = IntentSchema.parse(request.body);
    const conversationId = "web:local-owner";
    const workspace = body.workspaceId
      ? await runtime.files.registry.select(conversationId, body.workspaceId)
      : await runtime.files.registry.selected(conversationId);
    const requestId = body.requestId ?? `web_${ulid()}`;
    const timezone = validTimezone(body.timezone) ?? systemTimezone();
    runtime.intentProgress.start({ requestId, conversationId, workspaceId: workspace.id });
    const messageId = requestId;
    try {
      const result = await runtime.application.submitIntent({
        messageId,
        channel: "web",
        conversationId,
        actorId: "human:owner",
        text: body.text,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspacePath: workspace.realPath,
        timezone,
        onProgress: (phase) => { runtime.intentProgress.update(requestId, phase); },
      });
      runtime.intentProgress.update(requestId, "completed");
      return reply.code(202).send(result);
    } catch (error) {
      runtime.intentProgress.update(requestId, "failed", "intent-failed");
      throw error;
    }
  });
  server.post("/api/actions", async (request) => {
    const body = ActionSchema.parse(request.body);
    const key = `web:action:${ulid()}`;
    switch (body.action) {
      case "approve":
        return runtime.application.approveMutation(body.aggregateId, "human:owner", key);
      case "reject":
        return runtime.application.rejectMutation(body.aggregateId, "human:owner", key, body.reason ?? "Rejected from web");
      case "revise":
        return runtime.application.rejectMutation(body.aggregateId, "human:owner", key, body.reason ?? "Revision requested from web", true);
      case "cancel":
        return runtime.application.cancelRun(body.aggregateId, "human:owner", key);
      case "accept":
        return runtime.application.acceptWork(body.aggregateId, "human:owner", key);
      case "reject_acceptance":
        return runtime.application.rejectWork(body.aggregateId, "human:owner", key, body.reason ?? "Changes requested from web");
      case "approve_proposal": {
        return runtime.control.approveProductionProposal(body.aggregateId);
      }
      case "reject_proposal":
        return runtime.control.rejectProductionProposal(body.aggregateId, body.reason);
    }
  });
  server.get("/api/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    let lastStateSignature = "";
    let lastProgressSignature = "";
    const send = () => {
      const projection = runtime.application.getProjection();
      const stateSignature = JSON.stringify({
        graphVersion: projection.graph.version,
        mutations: Object.values(projection.mutations).map((item) => [item.id, item.updatedAt]),
        runs: Object.values(projection.runs).map((item) => [item.id, item.updatedAt]),
        judgments: projection.judgments.length,
        evidence: Object.keys(projection.evidence).length,
        messages: projection.messages.map((item) => [item.id, item.occurredAt]),
        stewardResponses: (projection.stewardResponses ?? []).map((item) => [item.id, item.occurredAt]),
        cards: Object.values(projection.cards).map((item) => [item.outTrackId, item.updatedAt]),
        agents: Object.values(projection.agents ?? {}).map((item) => [item.id, item.updatedAt]),
        agentSessions: Object.values(projection.agentSessions ?? {}).map((item) => [item.id, item.updatedAt]),
        workers: Object.values(projection.workers ?? {}).map((item) => [item.id, item.updatedAt]),
        workerSpecs: Object.values(projection.workerSpecs ?? {}).map((item) => [item.id, item.version]),
        workerSessions: Object.values(projection.workerSessions ?? {}).map((item) => [item.id, item.phase, item.updatedAt]),
        tasks: Object.values(projection.tasks ?? {}).map((item) => [item.id, item.version, item.status, item.updatedAt]),
        taskAttempts: Object.values(projection.taskAttempts ?? {}).map((item) => [item.id, item.phase, item.updatedAt]),
        commands: Object.values(projection.commands ?? {}).map((item) => [item.id, item.status, item.updatedAt]),
        changeSets: Object.values(projection.changeSets ?? {}).map((item) => [item.id, item.status, item.updatedAt]),
        flows: Object.values(projection.flows ?? {}).map((item) => [item.id, item.updatedAt]),
        flowRuns: Object.values(projection.flowRuns ?? {}).map((item) => [item.id, item.updatedAt]),
        stepRuns: Object.values(projection.stepRuns ?? {}).map((item) => [item.id, item.updatedAt]),
        stepAttempts: Object.values(projection.stepAttempts ?? {}).map((item) => [item.id, item.phase, item.completedAt]),
        stepResults: Object.values(projection.stepResults ?? {}).map((item) => [item.id, item.completedAt]),
        humanTasks: Object.values(projection.humanTasks ?? {}).map((item) => [item.id, item.updatedAt]),
        permissionLeases: Object.values(projection.permissionLeases ?? {}).map((item) => [item.id, item.status]),
        permissionRequests: Object.values(projection.permissionRequests ?? {}).map((item) => [item.id, item.updatedAt]),
        attention: Object.values(projection.attention ?? {}).map((item) => [item.id, item.updatedAt]),
        conversationBlocks: (projection.conversationBlocks ?? []).map((item) => [item.id, item.updatedAt, item.status]),
        designSessions: Object.values(projection.designSessions ?? {}).map((item) => [item.id, item.updatedAt, item.status]),
        productionProposals: Object.values(projection.productionProposals ?? {}).map((item) => [item.id, item.updatedAt, item.status]),
      });
      if (stateSignature !== lastStateSignature) {
        lastStateSignature = stateSignature;
        reply.raw.write(`event: state\ndata: ${JSON.stringify(projection)}\n\n`);
      }
      const progress = runtime.intentProgress.list("web:local-owner");
      const progressSignature = JSON.stringify(progress.map((item) => [item.requestId, item.phase, item.updatedAt]));
      if (progressSignature !== lastProgressSignature) {
        lastProgressSignature = progressSignature;
        reply.raw.write(`event: intent-progress\ndata: ${JSON.stringify(progress)}\n\n`);
      }
    };
    send();
    const interval = setInterval(send, 500);
    request.raw.on("close", () => clearInterval(interval));
    return reply;
  });

  const webRoot = resolve(process.cwd(), "dist/web");
  if (existsSync(webRoot)) {
    await server.register(fastifyStatic, { root: webRoot, wildcard: false });
    server.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }
  return server;
}

function validTimezone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return value; }
  catch { return undefined; }
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function matchesRuntimeReference(event: { aggregateId: string; payload: unknown }, key: string, value?: string): boolean {
  if (!value) return true;
  if (event.aggregateId === value) return true;
  return containsReference(event.payload, key, value, 0);
}

function containsReference(candidate: unknown, key: string, value: string, depth: number): boolean {
  if (!candidate || typeof candidate !== "object" || depth > 6) return false;
  if (Array.isArray(candidate)) return candidate.some((item) => containsReference(item, key, value, depth + 1));
  const record = candidate as Record<string, unknown>;
  if (record[key] === value) return true;
  return Object.values(record).some((item) => containsReference(item, key, value, depth + 1));
}

function requestKey(request: { headers: Record<string, unknown> }, prefix: string): string {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" && value.trim() ? value : `web:${prefix}:${ulid()}`;
}
