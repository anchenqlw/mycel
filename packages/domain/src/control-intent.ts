import { z } from "zod";

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

export const ChangeOperationSchema = z.object({
  id: z.string().min(1),
  kind: ChangeOperationKindSchema,
  targetId: z.string().optional(),
  expectedVersion: z.number().int().positive().optional(),
  dependsOn: z.array(z.string()).default([]),
  payload: z.record(z.string(), z.unknown()),
});

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
