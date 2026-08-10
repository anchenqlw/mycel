import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "paused",
  "blocked",
  "awaiting-acceptance",
  "completed",
  "failed",
  "canceled",
]);

export const TaskSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation"), conversationId: z.string().min(1) }),
  z.object({ kind: z.literal("flow"), flowId: z.string().min(1), flowRunId: z.string().min(1), stepId: z.string().min(1) }),
  z.object({ kind: z.literal("graph"), workId: z.string().min(1) }),
]);

export const TaskBudgetSchema = z.object({
  maxAttempts: z.number().int().positive(),
  maxRuntimeMs: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative().optional(),
});

export const TaskSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string(),
  source: TaskSourceSchema,
  initiatorActorId: z.string().min(1),
  ownerActorId: z.string().min(1),
  candidateWorkerIds: z.array(z.string()),
  humanActorIds: z.array(z.string()),
  workspaceId: z.string().min(1),
  permissionCeiling: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()).min(1),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  status: TaskStatusSchema,
  budget: TaskBudgetSchema,
  currentAttemptId: z.string().optional(),
  attemptIds: z.array(z.string()),
  resultSummary: z.string().optional(),
  evidenceIds: z.array(z.string()),
  dueAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const TaskAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  taskId: z.string().min(1),
  ordinal: z.number().int().positive(),
  version: z.number().int().positive(),
  phase: z.enum(["starting", "running", "blocked", "completed", "failed", "interrupted", "canceled"]),
  assigneeKind: z.enum(["worker", "human"]),
  workerId: z.string().optional(),
  humanActorId: z.string().optional(),
  workerSpecVersionId: z.string().optional(),
  workerSessionId: z.string().optional(),
  humanTaskId: z.string().optional(),
  permissionLeaseId: z.string().optional(),
  retryOf: z.string().optional(),
  replacedBy: z.string().optional(),
  resultSummary: z.string().optional(),
  evidenceIds: z.array(z.string()),
  error: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskSource = z.infer<typeof TaskSourceSchema>;
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskAttempt = z.infer<typeof TaskAttemptSchema>;

const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  draft: new Set(["ready", "canceled"]),
  ready: new Set(["running", "canceled"]),
  running: new Set(["paused", "blocked", "awaiting-acceptance", "failed", "canceled"]),
  paused: new Set(["running", "canceled"]),
  blocked: new Set(["running", "failed", "canceled"]),
  "awaiting-acceptance": new Set(["completed", "running", "canceled"]),
  completed: new Set(),
  failed: new Set(["running", "canceled"]),
  canceled: new Set(),
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!taskTransitions[from].has(to)) throw new Error(`illegal Task transition: ${from} -> ${to}`);
}
