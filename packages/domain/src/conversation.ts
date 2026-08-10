import { z } from "zod";
import { ControlResourceReferenceSchema, StewardChangeSetDraftSchema, StewardCommandDraftSchema, type ControlCommand, type ControlResourceReference } from "./control-intent.js";

const PlanActorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["human", "adopted-agent", "graph-agent"]),
  existingActorId: z.string().min(1).optional(),
  engine: z.enum(["claude-code", "codex"]).optional(),
  prompt: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
});

const PlanWorkspaceSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  purpose: z.string().min(1),
  access: z.enum(["read", "write"]),
});

const PlanTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("schedule"), intervalMs: z.number().int().min(10_000), timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().min(1) }),
  z.object({ kind: z.literal("graph-event"), eventType: z.string().min(1) }),
  z.object({ kind: z.literal("file-change"), glob: z.string().min(1) }),
  z.object({ kind: z.literal("webhook"), key: z.string().min(1) }),
]);

const PlanStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  actorId: z.string().min(1),
  prompt: z.string().min(1),
  workspaceIds: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string().min(1)).default([]),
  condition: z.enum(["always", "previous-succeeded", "previous-failed"]).default("previous-succeeded"),
  join: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("all") }),
    z.object({ mode: z.literal("any") }),
    z.object({ mode: z.literal("race") }),
    z.object({ mode: z.literal("quorum"), quorum: z.number().int().positive() }),
  ]).default({ mode: "all" }),
  timeoutMs: z.number().int().min(1_000),
  maxAttempts: z.number().int().min(1).max(10),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
});

export const ProductionPlanSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  actors: z.array(PlanActorSchema).min(1),
  workspaces: z.array(PlanWorkspaceSchema),
  trigger: PlanTriggerSchema,
  steps: z.array(PlanStepSchema).min(1),
  permissionCeiling: z.array(z.string().min(1)),
  budget: z.object({ maxRuntimeMs: z.number().int().min(1_000), maxTotalAttempts: z.number().int().min(1), maxCostUsd: z.number().positive().optional() }),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});
export type ProductionPlan = z.infer<typeof ProductionPlanSchema>;

export interface PlanDiagnostic {
  code: string;
  path: string;
  message: string;
}

export interface DesignSession {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  status: "clarifying" | "ready" | "deployed" | "abandoned";
  summary: string;
  decisions: string[];
  openQuestion?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductionProposal {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  designSessionId?: string;
  status: "ready" | "approved" | "rejected" | "failed" | "stale";
  plan: ProductionPlan;
  compiledFlowId: string;
  diagnostics: PlanDiagnostic[];
  createdAt: string;
  updatedAt: string;
}

export type ResourceKind = "graph" | "agent" | "worker" | "worker-spec" | "flow" | "run" | "flow-run" | "task" | "worker-session" | "human-task" | "workspace" | "file" | "evidence" | "history";
export interface ResourceReference { kind: ResourceKind; id: string; label: string; workspaceId?: string | undefined; path?: string | undefined }

export type TypedCommand =
  | { name: "open-resource"; resource: ResourceReference }
  | { name: "approve-proposal"; proposalId: string }
  | { name: "reject-proposal"; proposalId: string; reason?: string | undefined }
  | { name: "trigger-flow"; flowId: string }
  | { name: "approve-permission"; requestId: string }
  | { name: "complete-human-task"; taskId: string };

export type ConversationBlockKind = "answer" | "clarification" | "proposal" | "changeset" | "resource" | "command" | "run" | "human-task" | "permission" | "recovery";
export interface ConversationBlock {
  id: string;
  conversationId: string;
  sourceMessageId?: string;
  kind: ConversationBlockKind;
  title?: string;
  text: string;
  status: "active" | "resolved" | "failed";
  proposalId?: string;
  resource?: ResourceReference | ControlResourceReference;
  command?: TypedCommand | ControlCommand;
  changeSetId?: string;
  diagnostics?: PlanDiagnostic[];
  createdAt: string;
  updatedAt: string;
}

const StewardTextSchema = z.object({ text: z.string().min(1), reasoningSummary: z.string().min(1) });
export const HarnessIntentSchema = z.discriminatedUnion("kind", [
  StewardTextSchema.extend({ kind: z.literal("answer") }),
  StewardTextSchema.extend({ kind: z.literal("clarification"), design: z.object({ summary: z.string().min(1), decisions: z.array(z.string()).default([]), openQuestion: z.string().min(1) }).optional() }),
  z.object({ kind: z.literal("proposal"), text: z.string().min(1), reasoningSummary: z.string().min(1), plan: ProductionPlanSchema, designSummary: z.string().optional() }),
  z.object({ kind: z.literal("resource"), text: z.string().min(1), reasoningSummary: z.string().min(1), resource: z.union([ControlResourceReferenceSchema, z.object({ kind: z.enum(["graph", "agent", "flow", "run", "file", "history"]), id: z.string().min(1), label: z.string().min(1), workspaceId: z.string().optional(), path: z.string().optional() })]) }),
  z.object({ kind: z.literal("command"), text: z.string().min(1), reasoningSummary: z.string().min(1), command: z.union([StewardCommandDraftSchema, z.discriminatedUnion("name", [
    z.object({ name: z.literal("open-resource"), resource: z.object({ kind: z.enum(["graph", "agent", "flow", "run", "file", "history"]), id: z.string().min(1), label: z.string().min(1), workspaceId: z.string().optional(), path: z.string().optional() }) }),
    z.object({ name: z.literal("approve-proposal"), proposalId: z.string().min(1) }),
    z.object({ name: z.literal("reject-proposal"), proposalId: z.string().min(1), reason: z.string().optional() }),
    z.object({ name: z.literal("trigger-flow"), flowId: z.string().min(1) }),
    z.object({ name: z.literal("approve-permission"), requestId: z.string().min(1) }),
    z.object({ name: z.literal("complete-human-task"), taskId: z.string().min(1) }),
  ])]) }),
  z.object({ kind: z.literal("changeset"), text: z.string().min(1), reasoningSummary: z.string().min(1), changeSet: StewardChangeSetDraftSchema }),
]);
export type HarnessIntent = z.infer<typeof HarnessIntentSchema>;
