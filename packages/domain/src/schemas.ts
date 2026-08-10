import { z } from "zod";

export const RiskLevelSchema = z.enum(["green", "yellow", "red"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const WorkStatusSchema = z.enum([
  "proposed",
  "approved",
  "running",
  "awaiting_acceptance",
  "completed",
  "failed",
  "canceled",
]);
export type WorkStatus = z.infer<typeof WorkStatusSchema>;

const BaseNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  subgraphId: z.string().min(1).optional(),
  archivedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ActorNodeSchema = BaseNodeSchema.extend({
  type: z.literal("actor"),
  kind: z.enum(["human", "agent"]),
  runtime: z.string().optional(),
  status: z.enum(["online", "offline", "busy", "degraded"]),
  source: z.enum(["human", "system", "adopted", "graph-native"]).optional(),
  adapterKind: z.enum(["claude-code", "codex", "mcp", "a2a"]).optional(),
  lifecycle: z.enum(["run-scoped", "flow-scoped", "persistent", "archived"]).optional(),
  specVersionId: z.string().min(1).optional(),
  harnessPrompt: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).optional(),
  tools: z.array(z.string().min(1)).optional(),
  canOrchestrate: z.boolean().optional(),
  dingtalkUserId: z.string().min(1).optional(),
});

export const WorkNodeSchema = BaseNodeSchema.extend({
  type: z.literal("work"),
  kind: z.enum(["run", "flow", "step"]),
  workType: z.enum(["execute", "decision", "approval", "wait", "observe", "acceptance"]).optional(),
  parentWorkId: z.string().min(1).optional(),
  flowVersionId: z.string().min(1).optional(),
  description: z.string(),
  status: WorkStatusSchema,
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  risk: RiskLevelSchema,
});

export const ArtifactNodeSchema = BaseNodeSchema.extend({
  type: z.literal("artifact"),
  kind: z.enum(["patch", "test-report", "execution-summary", "log", "file", "knowledge", "evidence", "flow-version", "agent-spec"]),
  uri: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  summary: z.string(),
});

export const CapabilityNodeSchema = BaseNodeSchema.extend({
  type: z.literal("capability"),
  kind: z.enum([
    "claude-code",
    "codex",
    "agent-runtime",
    "repository-read",
    "repository-write",
    "test-command",
    "tool",
    "skill",
    "trigger",
    "orchestrate-agents",
  ]),
  scope: z.string().min(1),
  constraints: z.record(z.string(), z.unknown()),
});

export const GraphNodeSchema = z.discriminatedUnion("type", [
  ActorNodeSchema,
  WorkNodeSchema,
  ArtifactNodeSchema,
  CapabilityNodeSchema,
]);
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum([
      "depends_on",
      "assignment",
      "delegation",
      "contains",
      "produces",
      "references",
      "authorization",
      "equipped_with",
      "configured_by",
      "instantiates",
    ]),
    from: z.string().min(1),
    to: z.string().min(1),
    role: z.enum(["executor", "owner", "acceptor", "contributor"]).optional(),
    permission: z.enum(["read", "write", "execute", "delegate"]).optional(),
    scope: z.string().optional(),
    subgraphId: z.string().min(1).optional(),
    condition: z.string().optional(),
    expiresAt: z.string().datetime().optional(),
    source: z.string().optional(),
  })
  .superRefine((edge, context) => {
    if (edge.type === "assignment" && edge.role === undefined) {
      context.addIssue({ code: "custom", message: "assignment edges require a role" });
    }
    if (edge.type !== "assignment" && edge.role !== undefined) {
      context.addIssue({ code: "custom", message: "only assignment edges may have a role" });
    }
  });
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

const OperationBaseSchema = z.object({
  operationId: z.string().min(1),
  explanation: z.string().min(1),
});

export const WeaveOperationSchema = z.discriminatedUnion("op", [
  OperationBaseSchema.extend({ op: z.literal("add_node"), node: GraphNodeSchema }),
  OperationBaseSchema.extend({
    op: z.literal("update_node"),
    nodeId: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
  }),
  OperationBaseSchema.extend({ op: z.literal("add_edge"), edge: GraphEdgeSchema }),
  OperationBaseSchema.extend({ op: z.literal("remove_edge"), edgeId: z.string().min(1), edgeType: GraphEdgeSchema.shape.type }),
]);
export type WeaveOperation = z.infer<typeof WeaveOperationSchema>;

export const ExecutionDraftSchema = z.object({
  executorActorId: z.string().min(1),
  repositoryId: z.string().min(1),
  testCommandId: z.string().min(1),
  requiredEvidence: z.array(z.enum(["patch", "test-report", "execution-summary"])).min(1),
});

export const WeaveDiffSchema = z.object({
  id: z.string().min(1),
  baseGraphVersion: z.number().int().nonnegative(),
  originatorActorId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  intentSummary: z.string().min(1),
  workTitle: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  operations: z.array(WeaveOperationSchema).min(1),
  executionDraft: ExecutionDraftSchema,
  stewardExplanation: z.string().min(1),
});
export type WeaveDiff = z.infer<typeof WeaveDiffSchema>;

const StewardTextResultSchema = z.object({
  text: z.string().min(1),
  reasoningSummary: z.string().min(1),
});

export const StewardResultSchema = z.discriminatedUnion("kind", [
  StewardTextResultSchema.extend({ kind: z.literal("answer") }),
  StewardTextResultSchema.extend({ kind: z.literal("clarification") }),
  z.object({ kind: z.literal("weave_diff"), diff: WeaveDiffSchema }),
]);
export type StewardResult = z.infer<typeof StewardResultSchema>;

export const ExecutionContractSchema = z.object({
  runId: z.string().min(1),
  workId: z.string().min(1),
  executorActorId: z.string().min(1),
  repositoryId: z.string().min(1),
  baselineCommit: z.string().min(7),
  worktreePath: z.string().min(1),
  task: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  allowedTools: z.array(z.enum(["Read", "Glob", "Grep", "Edit", "Write"])),
  testCommandArgv: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
  maxBudgetUsd: z.number().positive(),
  requiredEvidence: z.array(z.enum(["patch", "test-report", "execution-summary"])).min(1),
  ownerActorId: z.string().min(1),
  acceptorActorId: z.string().min(1),
});
export type ExecutionContract = z.infer<typeof ExecutionContractSchema>;

export const EvidenceSchema = z.object({
  artifactId: z.string().min(1),
  runId: z.string().min(1),
  workId: z.string().min(1),
  kind: z.enum(["patch", "test-report", "execution-summary", "log"]),
  uri: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  summary: z.string(),
  passed: z.boolean().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
