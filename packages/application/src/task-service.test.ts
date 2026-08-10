import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@mycel/ledger-sqlite";
import { TaskService } from "./task-service.js";
import { emptyProjection, reduceProjection } from "./projection.js";

const createInput = {
  id: "task:review",
  title: "Review the release",
  description: "Check evidence and report findings.",
  source: { kind: "conversation" as const, conversationId: "conversation:1" },
  initiatorActorId: "human:owner",
  ownerActorId: "human:owner",
  candidateWorkerIds: ["worker:reviewer"],
  humanActorIds: ["human:owner"],
  workspaceId: "workspace:repo",
  permissionCeiling: ["repository-read"],
  acceptanceCriteria: ["findings are supported by evidence"],
  priority: "normal" as const,
  budget: { maxAttempts: 3, maxRuntimeMs: 300_000, maxCostUsd: 3 },
};

describe("TaskService", () => {
  const makeStore = () => new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);

  it("keeps a Task identity across pause, resume, retry, and worker replacement", () => {
    const store = makeStore();
    const service = new TaskService(store);
    const task = service.create(createInput, { actorId: "human:owner", idempotencyKey: "create:review" });
    const first = service.start(task.id, { workerId: "worker:reviewer" }, { actorId: "human:owner", expectedVersion: 1, idempotencyKey: "start:review" });

    expect(first.task.status).toBe("running");
    expect(first.attempt.ordinal).toBe(1);
    expect(first.attempt.taskId).toBe(task.id);

    const paused = service.pause(task.id, { actorId: "human:owner", expectedVersion: 2, idempotencyKey: "pause:review" });
    expect(paused.status).toBe("paused");
    expect(service.resume(task.id, { actorId: "human:owner", expectedVersion: 3, idempotencyKey: "resume:review" }).status).toBe("running");

    service.failAttempt(first.attempt.id, "provider unavailable", { actorId: "system", idempotencyKey: "fail:first" });
    const retry = service.retry(task.id, { actorId: "human:owner", expectedVersion: 5, idempotencyKey: "retry:review" });
    expect(retry.attempt).toMatchObject({ ordinal: 2, retryOf: first.attempt.id, workerId: "worker:reviewer" });

    service.failAttempt(retry.attempt.id, "worker unsuitable", { actorId: "system", idempotencyKey: "fail:second" });
    const replacement = service.replaceWorker(task.id, "worker:backup", { actorId: "human:owner", expectedVersion: 7, idempotencyKey: "replace:review" });
    expect(replacement.task.id).toBe(task.id);
    expect(replacement.attempt).toMatchObject({ ordinal: 3, retryOf: retry.attempt.id, workerId: "worker:backup" });
    expect(store.getProjection().taskAttempts[first.attempt.id]?.phase).toBe("failed");
  });

  it("requires evidence-ready completion and explicit acceptance", () => {
    const store = makeStore();
    const service = new TaskService(store);
    const task = service.create(createInput, { actorId: "human:owner", idempotencyKey: "create:acceptance" });
    const { attempt } = service.start(task.id, { workerId: "worker:reviewer" }, { actorId: "human:owner", expectedVersion: 1, idempotencyKey: "start:acceptance" });

    const awaiting = service.completeAttempt(attempt.id, { summary: "Reviewed", evidenceIds: ["evidence:1"] }, { actorId: "worker:reviewer", idempotencyKey: "complete:attempt" });
    expect(awaiting.status).toBe("awaiting-acceptance");
    expect(() => service.accept(task.id, { actorId: "worker:reviewer", expectedVersion: 3, idempotencyKey: "self-accept" })).toThrow(/owner/i);
    expect(service.accept(task.id, { actorId: "human:owner", expectedVersion: 3, idempotencyKey: "accept" }).status).toBe("completed");
  });

  it("rejects stale expected versions and replays idempotent creates", () => {
    const store = makeStore();
    const service = new TaskService(store);
    const first = service.create(createInput, { actorId: "human:owner", idempotencyKey: "same" });
    expect(service.create(createInput, { actorId: "human:owner", idempotencyKey: "same" })).toEqual(first);
    expect(() => service.pause(first.id, { actorId: "human:owner", expectedVersion: 99, idempotencyKey: "stale" })).toThrow(/expected version/i);
  });

  it("updates durable Task fields without replacing Task identity or runtime state", () => {
    const store = makeStore();
    const service = new TaskService(store);
    const task = service.create(createInput, { actorId: "human:owner", idempotencyKey: "create:update" });
    const updated = service.updateDefinition(task.id, { title: "Review the final release", priority: "high", acceptanceCriteria: ["all findings cite evidence"] }, { actorId: "agent:steward", expectedVersion: 1, idempotencyKey: "update:definition" });
    expect(updated).toMatchObject({ id: task.id, version: 2, status: "ready", title: "Review the final release", priority: "high" });
    expect(updated.acceptanceCriteria).toEqual(["all findings cite evidence"]);
  });
});
