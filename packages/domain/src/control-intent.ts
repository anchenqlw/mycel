import { z } from "zod";
import { WorkerSpecVersionSchema } from "./worker.js";

export const ControlResourceKindSchema = z.enum([
  "graph", "worker", "worker-spec", "flow", "flow-run", "task", "worker-session",
  "human-task", "workspace", "file", "evidence", "history",
]);

export const ControlResourceReferenceSchema = z.object({
  kind: ControlResourceKindSchema,
  id: z.string().min(1),
  label: z.string().min(1),
  version: z.number().int().positive().optional(),
});

export const ControlCommandActionSchema = z.enum([
  "open-resource",
  "trigger-flow", "pause-flow", "resume-flow", "retire-flow",
  "pause-flow-run", "resume-flow-run", "cancel-flow-run", "retry-flow-run",
  "start-task", "pause-task", "resume-task", "cancel-task", "reassign-task", "accept-task", "retry-task",
  "send-worker-session", "interrupt-worker-session", "resume-worker-session", "cancel-worker-session", "retry-worker-session", "fork-worker-session", "replace-worker",
  "claim-human-task", "release-human-task", "reassign-human-task", "complete-human-task", "reject-human-task",
]);

export const ControlCommandSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  action: ControlCommandActionSchema,
  target: ControlResourceReferenceSchema,
  arguments: z.record(z.string(), z.unknown()).default({}),
  expectedVersion: z.number().int().positive().optional(),
  contextVersion: z.number().int().nonnegative(),
  initiatedBy: z.string().min(1),
  sourceMessageId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  status: z.enum(["planned", "executing", "succeeded", "failed"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ChangeOperationKindSchema = z.enum([
  "create-graph-node", "update-graph-node", "archive-graph-node", "create-graph-edge", "remove-graph-edge",
  "create-worker", "update-worker", "archive-worker", "publish-worker-spec",
  "create-flow", "update-flow", "publish-flow", "archive-flow",
  "create-task", "update-task",
]);

const NonEmptyStringSchema = z.string().trim().min(1);
const ReferenceSchema = z.union([NonEmptyStringSchema, z.object({ ref: NonEmptyStringSchema })]);
const TargetPayloadSchema = (key: string) => z.object({ [key]: NonEmptyStringSchema.optional() }).strict();
const DraftFlowStepSchema = z.object({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  actorId: NonEmptyStringSchema.optional(),
  actorRef: NonEmptyStringSchema.optional(),
  existingActorId: NonEmptyStringSchema.optional(),
  kind: z.enum(["agent", "human"]).optional(),
  prompt: z.string().optional(),
  dependsOn: z.array(NonEmptyStringSchema).default([]),
  condition: z.enum(["always", "previous-succeeded", "previous-failed"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  workspaceIds: z.array(NonEmptyStringSchema).optional(),
  join: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("all") }).strict(),
    z.object({ mode: z.literal("any") }).strict(),
    z.object({ mode: z.literal("race") }).strict(),
    z.object({ mode: z.literal("quorum"), quorum: z.number().int().positive() }).strict(),
  ]).optional(),
  requiredCapabilities: z.array(NonEmptyStringSchema).optional(),
}).strict().refine((step) => step.actorId || step.actorRef || step.existingActorId, { message: "actor reference is required", path: ["actorId"] });
const DraftFlowTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("schedule"), intervalMs: z.number().int().positive(), timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), timezone: NonEmptyStringSchema.optional() }).strict(),
  z.object({ kind: z.literal("graph-event"), eventType: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal("file-change"), glob: NonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal("webhook"), key: NonEmptyStringSchema }).strict(),
]);
const DraftFlowSchema = z.object({
  name: NonEmptyStringSchema,
  description: z.string().optional(),
  workspaceId: NonEmptyStringSchema.optional(),
  workspaceRef: NonEmptyStringSchema.optional(),
  trigger: DraftFlowTriggerSchema.optional(),
  steps: z.array(DraftFlowStepSchema).min(1),
  permissionCeiling: z.array(NonEmptyStringSchema).optional(),
  maxConcurrency: z.number().int().positive().optional(),
  budget: z.object({ maxRuntimeMs: z.number().int().positive(), maxTotalAttempts: z.number().int().positive(), maxCostUsd: z.number().positive().optional() }).strict().optional(),
  actors: z.array(z.object({ id: NonEmptyStringSchema, existingActorId: NonEmptyStringSchema, kind: z.string().optional(), name: z.string().optional() }).strict()).optional(),
  workspaces: z.array(z.object({ id: NonEmptyStringSchema, workspaceId: NonEmptyStringSchema, purpose: z.string().optional(), access: z.enum(["read", "write"]).optional() }).strict()).optional(),
  id: NonEmptyStringSchema.optional(),
  status: z.enum(["draft", "published", "paused", "retired"]).optional(),
  version: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
}).strict();
const DraftFlowPatchSchema = DraftFlowSchema.omit({ name: true, steps: true, id: true, status: true, version: true, createdAt: true, updatedAt: true }).extend({
  name: NonEmptyStringSchema.optional(),
  steps: z.array(DraftFlowStepSchema).min(1).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "flow patch must not be empty" });

const GraphNodeDraftSchema = z.discriminatedUnion("type", [
  z.object({ id: NonEmptyStringSchema.optional(), name: NonEmptyStringSchema, type: z.literal("actor"), kind: z.enum(["human", "agent"]), runtime: z.string().optional(), status: z.enum(["online", "offline", "busy", "degraded"]).optional(), source: z.enum(["human", "system", "adopted", "graph-native"]).optional(), adapterKind: z.enum(["claude-code", "codex", "mcp", "a2a"]).optional(), lifecycle: z.enum(["run-scoped", "flow-scoped", "persistent", "archived"]).optional(), specVersionId: NonEmptyStringSchema.optional(), harnessPrompt: NonEmptyStringSchema.optional(), skills: z.array(NonEmptyStringSchema).optional(), tools: z.array(NonEmptyStringSchema).optional(), canOrchestrate: z.boolean().optional(), dingtalkUserId: NonEmptyStringSchema.optional(), archivedAt: z.string().datetime().optional(), createdAt: z.string().datetime().optional(), updatedAt: z.string().datetime().optional() }).strict(),
  z.object({ id: NonEmptyStringSchema.optional(), name: NonEmptyStringSchema, type: z.literal("work"), kind: z.enum(["run", "flow", "step"]), status: z.enum(["proposed", "approved", "running", "awaiting_acceptance", "completed", "failed", "canceled"]).optional(), workType: z.enum(["execute", "decision", "approval", "wait", "observe", "acceptance"]).optional(), parentWorkId: NonEmptyStringSchema.optional(), flowVersionId: NonEmptyStringSchema.optional(), description: z.string(), acceptanceCriteria: z.array(NonEmptyStringSchema).min(1), risk: z.enum(["green", "yellow", "red"]), archivedAt: z.string().datetime().optional(), createdAt: z.string().datetime().optional(), updatedAt: z.string().datetime().optional() }).strict(),
  z.object({ id: NonEmptyStringSchema.optional(), name: NonEmptyStringSchema, type: z.literal("artifact"), kind: z.enum(["patch", "test-report", "execution-summary", "log", "file", "knowledge", "evidence", "flow-version", "agent-spec"]), uri: NonEmptyStringSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/i), mediaType: NonEmptyStringSchema, summary: z.string(), archivedAt: z.string().datetime().optional(), createdAt: z.string().datetime().optional(), updatedAt: z.string().datetime().optional() }).strict(),
  z.object({ id: NonEmptyStringSchema.optional(), name: NonEmptyStringSchema, type: z.literal("capability"), kind: z.enum(["claude-code", "codex", "agent-runtime", "repository-read", "repository-write", "test-command", "tool", "skill", "trigger", "orchestrate-agents"]), scope: NonEmptyStringSchema, constraints: z.record(z.string(), z.unknown()), archivedAt: z.string().datetime().optional(), createdAt: z.string().datetime().optional(), updatedAt: z.string().datetime().optional() }).strict(),
]);
const GraphNodePatchSchema = z.object({
  name: NonEmptyStringSchema.optional(), subgraphId: NonEmptyStringSchema.optional(), runtime: z.string().optional(), status: z.enum(["online", "offline", "busy", "degraded", "proposed", "approved", "running", "awaiting_acceptance", "completed", "failed", "canceled"]).optional(), source: z.enum(["human", "system", "adopted", "graph-native"]).optional(), adapterKind: z.enum(["claude-code", "codex", "mcp", "a2a"]).optional(), lifecycle: z.enum(["run-scoped", "flow-scoped", "persistent", "archived"]).optional(), specVersionId: NonEmptyStringSchema.optional(), harnessPrompt: NonEmptyStringSchema.optional(), skills: z.array(NonEmptyStringSchema).optional(), tools: z.array(NonEmptyStringSchema).optional(), canOrchestrate: z.boolean().optional(), dingtalkUserId: NonEmptyStringSchema.optional(), workType: z.enum(["execute", "decision", "approval", "wait", "observe", "acceptance"]).optional(), parentWorkId: NonEmptyStringSchema.optional(), flowVersionId: NonEmptyStringSchema.optional(), description: z.string().optional(), acceptanceCriteria: z.array(NonEmptyStringSchema).min(1).optional(), risk: z.enum(["green", "yellow", "red"]).optional(), uri: NonEmptyStringSchema.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), mediaType: NonEmptyStringSchema.optional(), summary: z.string().optional(), scope: NonEmptyStringSchema.optional(), constraints: z.record(z.string(), z.unknown()).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "node patch must not be empty" });
const GraphEdgeDraftSchema = z.object({
  id: NonEmptyStringSchema.optional(), type: z.enum(["depends_on", "assignment", "delegation", "contains", "produces", "references", "authorization", "equipped_with", "configured_by", "instantiates"]), from: ReferenceSchema.optional(), fromRef: NonEmptyStringSchema.optional(), to: ReferenceSchema.optional(), toRef: NonEmptyStringSchema.optional(), role: z.enum(["executor", "owner", "acceptor", "contributor"]).optional(), permission: z.enum(["read", "write", "execute", "delegate", "repository-read", "repository-write"]).optional(), scope: z.string().optional(), subgraphId: NonEmptyStringSchema.optional(), condition: z.string().optional(), expiresAt: z.string().datetime().optional(), source: z.string().optional(),
}).strict().refine((value) => value.from || value.fromRef, { message: "source reference is required", path: ["from"] }).refine((value) => value.to || value.toRef, { message: "target reference is required", path: ["to"] });

const WorkerSpecDraftSchema = WorkerSpecVersionSchema.omit({ schemaVersion: true, id: true, workerId: true, version: true, createdAt: true });
const WorkerPatchSchema = z.object({ name: NonEmptyStringSchema.optional(), status: z.enum(["online", "offline", "busy", "degraded"]).optional(), lifecycle: z.enum(["run-scoped", "flow-scoped", "persistent", "archived"]).optional(), contractLevel: z.enum(["status", "results", "evidence", "control"]).optional(), connectionUri: z.string().optional(), maxConcurrentSessions: z.number().int().positive().optional() }).strict().refine((value) => Object.keys(value).length > 0, { message: "worker patch must not be empty" });
const CreateTaskDraftSchema = z.object({ id: NonEmptyStringSchema.optional(), title: NonEmptyStringSchema, description: z.string(), source: z.discriminatedUnion("kind", [z.object({ kind: z.literal("conversation"), conversationId: NonEmptyStringSchema }), z.object({ kind: z.literal("flow"), flowId: NonEmptyStringSchema, flowRunId: NonEmptyStringSchema, stepId: NonEmptyStringSchema }), z.object({ kind: z.literal("graph"), workId: NonEmptyStringSchema })]), initiatorActorId: NonEmptyStringSchema, ownerActorId: NonEmptyStringSchema, candidateWorkerIds: z.array(NonEmptyStringSchema), humanActorIds: z.array(NonEmptyStringSchema), workspaceId: NonEmptyStringSchema, permissionCeiling: z.array(NonEmptyStringSchema), acceptanceCriteria: z.array(NonEmptyStringSchema).min(1), priority: z.enum(["low", "normal", "high", "urgent"]), budget: z.object({ maxAttempts: z.number().int().positive(), maxRuntimeMs: z.number().int().positive(), maxCostUsd: z.number().nonnegative().optional() }), dueAt: z.string().datetime().optional() }).strict();
const TaskPatchSchema = CreateTaskDraftSchema.omit({ id: true, source: true, initiatorActorId: true }).partial().strict().refine((value) => Object.keys(value).length > 0, { message: "task patch must not be empty" });

const ChangeOperationBaseSchema = z.object({
  id: z.string().min(1),
  kind: ChangeOperationKindSchema,
  targetId: z.string().optional(),
  expectedVersion: z.number().int().positive().optional(),
  dependsOn: z.array(z.string()).default([]),
  payload: z.record(z.string(), z.unknown()),
});

function payloadSchemaFor(kind: z.infer<typeof ChangeOperationKindSchema>): z.ZodTypeAny {
  switch (kind) {
    case "create-flow": return z.union([DraftFlowSchema, z.object({ flow: DraftFlowSchema }).strict()]);
    case "update-flow": return z.object({ flowId: NonEmptyStringSchema.optional(), patch: DraftFlowPatchSchema }).strict();
    case "publish-flow": return z.object({ flowId: NonEmptyStringSchema.optional(), flowRef: NonEmptyStringSchema.optional() }).strict();
    case "archive-flow": return TargetPayloadSchema("flowId");
    case "create-graph-node": return z.union([GraphNodeDraftSchema, z.object({ node: GraphNodeDraftSchema }).strict()]);
    case "update-graph-node": return z.object({ nodeId: NonEmptyStringSchema.optional(), patch: GraphNodePatchSchema }).strict();
    case "archive-graph-node": return TargetPayloadSchema("nodeId");
    case "create-graph-edge": return z.union([GraphEdgeDraftSchema, z.object({ edge: GraphEdgeDraftSchema }).strict()]);
    case "remove-graph-edge": return z.object({ edgeId: NonEmptyStringSchema.optional(), edgeType: GraphEdgeDraftSchema.shape.type }).strict();
    case "create-worker": return z.object({ name: NonEmptyStringSchema, spec: WorkerSpecDraftSchema }).strict();
    case "update-worker": return z.object({ workerId: NonEmptyStringSchema.optional(), patch: WorkerPatchSchema }).strict();
    case "archive-worker": return TargetPayloadSchema("workerId");
    case "publish-worker-spec": return z.object({ workerId: NonEmptyStringSchema.optional(), workerRef: NonEmptyStringSchema.optional(), spec: WorkerSpecDraftSchema }).strict();
    case "create-task": return CreateTaskDraftSchema;
    case "update-task": return z.object({ taskId: NonEmptyStringSchema.optional(), patch: TaskPatchSchema }).strict();
  }
}

export const ChangeOperationSchema = ChangeOperationBaseSchema.superRefine((operation, context) => {
  const result = payloadSchemaFor(operation.kind).safeParse(operation.payload);
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({ code: "custom", message: issue.message, path: ["payload", ...issue.path] });
    }
  }
  const hasTarget = typeof operation.targetId === "string" && operation.targetId.trim().length > 0;
  if (["update-graph-node", "archive-graph-node", "remove-graph-edge", "update-worker", "archive-worker", "publish-worker-spec", "update-flow", "publish-flow", "archive-flow", "update-task"].includes(operation.kind) && !hasTarget) {
    const fallbackKeys: Record<string, string[]> = {
      "update-graph-node": ["nodeId"], "archive-graph-node": ["nodeId"], "remove-graph-edge": ["edgeId"],
      "update-worker": ["workerId"], "archive-worker": ["workerId"], "update-flow": ["flowId"],
      "publish-worker-spec": ["workerId", "workerRef"], "publish-flow": ["flowId", "flowRef"],
      "archive-flow": ["flowId"], "update-task": ["taskId"],
    };
    if (!(fallbackKeys[operation.kind] ?? []).some((key) => typeof operation.payload[key] === "string" && String(operation.payload[key]).trim())) {
      context.addIssue({ code: "custom", message: "target reference is required", path: ["targetId"] });
    }
  }
});

export type ChangeOperationValidationResult =
  | { ok: true }
  | { ok: false; operationId: string; kind: string; field: string; message: string };

export function validateChangeOperation(operation: unknown): ChangeOperationValidationResult {
  const result = ChangeOperationSchema.safeParse(operation);
  if (result.success) return { ok: true };
  const input = typeof operation === "object" && operation !== null ? operation as Record<string, unknown> : {};
  const issue = result.error.issues[0];
  return {
    ok: false,
    operationId: typeof input.id === "string" ? input.id : "unknown",
    kind: typeof input.kind === "string" ? input.kind : "unknown",
    field: issue?.path.join(".") || "operation",
    message: issue?.message ?? "invalid operation",
  };
}

export function parseChangeOperationPayload(operation: ChangeOperation): Record<string, unknown> {
  const result = payloadSchemaFor(operation.kind).safeParse(operation.payload);
  if (!result.success || typeof result.data !== "object" || result.data === null || Array.isArray(result.data)) {
    throw new Error("ChangeOperation payload validation failed");
  }
  return result.data as Record<string, unknown>;
}

export const ChangePreconditionSchema = z.object({
  resource: ControlResourceReferenceSchema,
  expectedVersion: z.number().int().positive().optional(),
  expectedStatus: z.string().optional(),
});

export const ImpactSummarySchema = z.object({
  resourcesCreated: z.array(ControlResourceReferenceSchema),
  resourcesModified: z.array(ControlResourceReferenceSchema),
  resourcesArchived: z.array(ControlResourceReferenceSchema),
  permissionsAdded: z.array(z.string()),
  runtimeEffects: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const ChangeOperationResultSchema = z.object({
  operationId: z.string(),
  status: z.enum(["pending", "applied", "failed", "skipped"]),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export const ChangeSetSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  intentSummary: z.string().min(1),
  operations: z.array(ChangeOperationSchema).min(1),
  preconditions: z.array(ChangePreconditionSchema),
  impact: ImpactSummarySchema,
  aggregateRisk: z.enum(["green", "yellow", "red"]),
  status: z.enum(["draft", "validated", "awaiting-approval", "applying", "applied", "partially-applied", "rejected", "failed"]),
  operationResults: z.array(ChangeOperationResultSchema),
  contextVersion: z.number().int().nonnegative(),
  initiatedBy: z.string().min(1),
  sourceMessageId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  approvedBy: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const StewardCommandDraftSchema = z.object({
  action: ControlCommandActionSchema,
  target: ControlResourceReferenceSchema,
  arguments: z.record(z.string(), z.unknown()).default({}),
  expectedVersion: z.number().int().positive().optional(),
});

export const StewardChangeSetDraftSchema = z.object({
  title: z.string().min(1),
  intentSummary: z.string().min(1),
  operations: z.array(ChangeOperationSchema).min(1),
  preconditions: z.array(ChangePreconditionSchema).default([]),
});

export const UnifiedStewardIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), text: z.string().min(1), reasoningSummary: z.string().min(1) }),
  z.object({ kind: z.literal("clarification"), text: z.string().min(1), reasoningSummary: z.string().min(1), candidates: z.array(ControlResourceReferenceSchema).optional() }),
  z.object({ kind: z.literal("resource"), text: z.string().min(1), reasoningSummary: z.string().min(1), resource: ControlResourceReferenceSchema }),
  z.object({ kind: z.literal("command"), text: z.string().min(1), reasoningSummary: z.string().min(1), command: ControlCommandSchema }),
  z.object({ kind: z.literal("changeset"), text: z.string().min(1), reasoningSummary: z.string().min(1), changeSet: ChangeSetSchema }),
]);

export type ControlResourceKind = z.infer<typeof ControlResourceKindSchema>;
export type ControlResourceReference = z.infer<typeof ControlResourceReferenceSchema>;
export type ControlCommandAction = z.infer<typeof ControlCommandActionSchema>;
export type ControlCommand = z.infer<typeof ControlCommandSchema>;
export type ChangeOperationKind = z.infer<typeof ChangeOperationKindSchema>;
export type ChangeOperation = z.infer<typeof ChangeOperationSchema>;
export type ImpactSummary = z.infer<typeof ImpactSummarySchema>;
export type ChangeSet = z.infer<typeof ChangeSetSchema>;
export type UnifiedStewardIntent = z.infer<typeof UnifiedStewardIntentSchema>;
export type StewardCommandDraft = z.infer<typeof StewardCommandDraftSchema>;
export type StewardChangeSetDraft = z.infer<typeof StewardChangeSetDraftSchema>;
