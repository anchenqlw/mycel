import { ulid } from "ulid";
import {
  assertTaskTransition,
  type Task,
  type TaskAttempt,
  type TaskBudget,
  type TaskSource,
} from "@mycel/domain";
import type { EventStorePort } from "./ports.js";

export interface CreateTaskInput {
  id?: string;
  title: string;
  description: string;
  source: TaskSource;
  initiatorActorId: string;
  ownerActorId: string;
  candidateWorkerIds: string[];
  humanActorIds: string[];
  workspaceId: string;
  permissionCeiling: string[];
  acceptanceCriteria: string[];
  priority: Task["priority"];
  budget: TaskBudget;
  dueAt?: string;
}

export interface TaskMutationContext {
  actorId: string;
  idempotencyKey: string;
  expectedVersion?: number;
  correlationId?: string;
}

export class TaskService {
  readonly #store: EventStorePort;

  constructor(store: EventStorePort) {
    this.#store = store;
  }

  create(input: CreateTaskInput, context: TaskMutationContext): Task {
    const replayed = this.#replayedTask(context.idempotencyKey);
    if (replayed) return replayed;
    if (input.acceptanceCriteria.length === 0) throw new Error("Task requires at least one acceptance criterion");
    const now = new Date().toISOString();
    const task: Task = {
      schemaVersion: 1,
      id: input.id ?? `task_${ulid()}`,
      version: 1,
      title: input.title,
      description: input.description,
      source: input.source,
      initiatorActorId: input.initiatorActorId,
      ownerActorId: input.ownerActorId,
      candidateWorkerIds: [...input.candidateWorkerIds],
      humanActorIds: [...input.humanActorIds],
      workspaceId: input.workspaceId,
      permissionCeiling: [...input.permissionCeiling],
      acceptanceCriteria: [...input.acceptanceCriteria],
      priority: input.priority,
      status: "ready",
      budget: input.budget,
      attemptIds: [],
      evidenceIds: [],
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return this.#persistTask(task, context).task;
  }

  updateDefinition(taskId: string, patch: Partial<Pick<Task, "title" | "description" | "ownerActorId" | "candidateWorkerIds" | "humanActorIds" | "workspaceId" | "permissionCeiling" | "acceptanceCriteria" | "priority" | "budget" | "dueAt">>, context: TaskMutationContext): Task {
    const replayed = this.#replayedTask(context.idempotencyKey);
    if (replayed) return replayed;
    const task = this.#requiredTask(taskId, context.expectedVersion);
    if (patch.acceptanceCriteria?.length === 0) throw new Error("Task requires at least one acceptance criterion");
    const updated = { ...task, ...patch, version: task.version + 1, updatedAt: new Date().toISOString() };
    if (patch.dueAt === undefined && Object.prototype.hasOwnProperty.call(patch, "dueAt")) delete updated.dueAt;
    return this.#persistTask(updated, context).task;
  }

  start(taskId: string, assignee: { workerId: string; workerSpecVersionId?: string } | { humanActorId: string }, context: TaskMutationContext): { task: Task; attempt: TaskAttempt } {
    const replayed = this.#replayedTask(context.idempotencyKey);
    if (replayed?.currentAttemptId) return { task: replayed, attempt: this.#requiredAttempt(replayed.currentAttemptId) };
    const task = this.#requiredTask(taskId, context.expectedVersion);
    assertTaskTransition(task.status, "running");
    return this.#newAttempt(task, assignee, context);
  }

  pause(taskId: string, context: TaskMutationContext): Task {
    return this.#transition(taskId, "paused", context);
  }

  resume(taskId: string, context: TaskMutationContext): Task {
    return this.#transition(taskId, "running", context);
  }

  cancel(taskId: string, context: TaskMutationContext): Task {
    return this.#transition(taskId, "canceled", context);
  }

  block(taskId: string, reason: string, context: TaskMutationContext): Task {
    return this.#transition(taskId, "blocked", context, { resultSummary: reason });
  }

  failAttempt(attemptId: string, error: string, context: TaskMutationContext): Task {
    const replayed = this.#replayedTask(context.idempotencyKey);
    if (replayed) return replayed;
    const attempt = this.#requiredAttempt(attemptId);
    if (["completed", "failed", "canceled"].includes(attempt.phase)) {
      if (attempt.phase === "failed") return this.#requiredTask(attempt.taskId);
      throw new Error(`Task Attempt cannot fail from ${attempt.phase}`);
    }
    const now = new Date().toISOString();
    this.#persistAttempt({ ...attempt, version: attempt.version + 1, phase: "failed", error, updatedAt: now }, context);
    const task = this.#requiredTask(attempt.taskId);
    assertTaskTransition(task.status, "failed");
    return this.#persistTask({ ...task, version: task.version + 1, status: "failed", resultSummary: error, updatedAt: now }, context).task;
  }

  completeAttempt(attemptId: string, result: { summary: string; evidenceIds: string[] }, context: TaskMutationContext): Task {
    const replayed = this.#replayedTask(context.idempotencyKey);
    if (replayed) return replayed;
    if (result.evidenceIds.length === 0) throw new Error("Task completion requires evidence");
    const attempt = this.#requiredAttempt(attemptId);
    if (attempt.phase !== "running" && attempt.phase !== "blocked") throw new Error(`Task Attempt cannot complete from ${attempt.phase}`);
    const now = new Date().toISOString();
    this.#persistAttempt({ ...attempt, version: attempt.version + 1, phase: "completed", resultSummary: result.summary, evidenceIds: result.evidenceIds, updatedAt: now }, context);
    const task = this.#requiredTask(attempt.taskId);
    assertTaskTransition(task.status, "awaiting-acceptance");
    return this.#persistTask({ ...task, version: task.version + 1, status: "awaiting-acceptance", resultSummary: result.summary, evidenceIds: result.evidenceIds, updatedAt: now }, context).task;
  }

  accept(taskId: string, context: TaskMutationContext): Task {
    const replayed = this.#replayedTask(context.idempotencyKey);
    if (replayed) return replayed;
    const task = this.#requiredTask(taskId, context.expectedVersion);
    if (context.actorId !== task.ownerActorId) throw new Error("only the Task owner can accept completion");
    if (task.evidenceIds.length === 0) throw new Error("Task cannot be accepted without evidence");
    assertTaskTransition(task.status, "completed");
    return this.#persistTask({ ...task, version: task.version + 1, status: "completed", updatedAt: new Date().toISOString() }, context).task;
  }

  retry(taskId: string, context: TaskMutationContext): { task: Task; attempt: TaskAttempt } {
    const task = this.#requiredTask(taskId, context.expectedVersion);
    if (task.status !== "failed" && task.status !== "blocked") throw new Error(`Task cannot retry from ${task.status}`);
    const previous = task.currentAttemptId ? this.#requiredAttempt(task.currentAttemptId) : undefined;
    if (!previous) throw new Error("Task has no Attempt to retry");
    const assignee = previous.assigneeKind === "worker" && previous.workerId
      ? { workerId: previous.workerId, ...(previous.workerSpecVersionId ? { workerSpecVersionId: previous.workerSpecVersionId } : {}) }
      : { humanActorId: previous.humanActorId ?? task.ownerActorId };
    return this.#newAttempt(task, assignee, context, previous.id);
  }

  replaceWorker(taskId: string, workerId: string, context: TaskMutationContext): { task: Task; attempt: TaskAttempt } {
    const task = this.#requiredTask(taskId, context.expectedVersion);
    if (task.status !== "failed" && task.status !== "blocked" && task.status !== "paused") throw new Error(`Task cannot replace Worker from ${task.status}`);
    const previousId = task.currentAttemptId;
    return this.#newAttempt(task, { workerId }, context, previousId);
  }

  linkWorkerSession(attemptId: string, workerSessionId: string, context: TaskMutationContext): TaskAttempt {
    const attempt = this.#requiredAttempt(attemptId);
    if (attempt.workerSessionId === workerSessionId) return attempt;
    if (attempt.assigneeKind !== "worker") throw new Error("Human Task Attempts cannot link a Worker Session");
    const updated: TaskAttempt = { ...attempt, version: attempt.version + 1, workerSessionId, updatedAt: new Date().toISOString() };
    this.#persistAttempt(updated, context);
    return updated;
  }

  #newAttempt(task: Task, assignee: { workerId: string; workerSpecVersionId?: string } | { humanActorId: string }, context: TaskMutationContext, retryOf?: string): { task: Task; attempt: TaskAttempt } {
    if (task.attemptIds.length >= task.budget.maxAttempts) throw new Error("Task attempt budget exhausted");
    const now = new Date().toISOString();
    const attempt: TaskAttempt = {
      schemaVersion: 1,
      id: `attempt_${ulid()}`,
      taskId: task.id,
      ordinal: task.attemptIds.length + 1,
      version: 1,
      phase: "running",
      assigneeKind: "workerId" in assignee ? "worker" : "human",
      ...("workerId" in assignee ? { workerId: assignee.workerId, ...(assignee.workerSpecVersionId ? { workerSpecVersionId: assignee.workerSpecVersionId } : {}) } : { humanActorId: assignee.humanActorId }),
      ...(retryOf ? { retryOf } : {}),
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.#persistAttempt(attempt, context);
    if (retryOf) {
      const previous = this.#requiredAttempt(retryOf);
      this.#persistAttempt({ ...previous, version: previous.version + 1, replacedBy: attempt.id, updatedAt: now }, { ...context, idempotencyKey: `${context.idempotencyKey}:lineage` });
    }
    const updated: Task = {
      ...task,
      version: task.version + 1,
      status: "running",
      currentAttemptId: attempt.id,
      attemptIds: [...task.attemptIds, attempt.id],
      evidenceIds: [],
      updatedAt: now,
    };
    const persisted = this.#persistTask(updated, context).task;
    return { task: persisted, attempt };
  }

  #transition(taskId: string, status: Task["status"], context: TaskMutationContext, extra: Partial<Task> = {}): Task {
    const replayed = this.#replayedTask(context.idempotencyKey);
    if (replayed) return replayed;
    const task = this.#requiredTask(taskId, context.expectedVersion);
    assertTaskTransition(task.status, status);
    return this.#persistTask({ ...task, ...extra, version: task.version + 1, status, updatedAt: new Date().toISOString() }, context).task;
  }

  #persistTask(task: Task, context: TaskMutationContext) {
    return this.#store.append({
      eventType: "TaskEvent", aggregateType: "work", aggregateId: task.id, actorId: context.actorId,
      correlationId: context.correlationId ?? `task:${task.id}`, causationId: null,
      idempotencyKey: `${context.idempotencyKey}:task`, payload: { task },
    }).projection.tasks[task.id] ? { task: this.#store.getProjection().tasks[task.id]! } : { task };
  }

  #persistAttempt(attempt: TaskAttempt, context: TaskMutationContext): void {
    this.#store.append({
      eventType: "TaskAttemptEvent", aggregateType: "run", aggregateId: attempt.id, actorId: context.actorId,
      correlationId: context.correlationId ?? `task:${attempt.taskId}`, causationId: null,
      idempotencyKey: `${context.idempotencyKey}:attempt:${attempt.id}`, payload: { attempt },
    });
  }

  #requiredTask(taskId: string, expectedVersion?: number): Task {
    const task = this.#store.getProjection().tasks[taskId];
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (expectedVersion !== undefined && task.version !== expectedVersion) throw new Error(`Task expected version ${expectedVersion}, found ${task.version}`);
    return task;
  }

  #requiredAttempt(attemptId: string): TaskAttempt {
    const attempt = this.#store.getProjection().taskAttempts[attemptId];
    if (!attempt) throw new Error(`Task Attempt not found: ${attemptId}`);
    return attempt;
  }

  #replayedTask(idempotencyKey: string): Task | undefined {
    const event = this.#store.readAll().find((candidate) => candidate.idempotencyKey === `${idempotencyKey}:task`);
    if (!event) return undefined;
    const payload = event.payload as { task?: Task };
    return payload.task ? this.#store.getProjection().tasks[payload.task.id] : undefined;
  }
}
