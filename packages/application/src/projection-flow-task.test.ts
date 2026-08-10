import { describe, expect, it } from "vitest";
import type { EventEnvelope, FlowDefinition, FlowRun, StepAttempt, StepRun } from "@mycel/domain";
import { emptyProjection, reduceProjection } from "./projection.js";

const now = "2026-08-05T00:00:00.000Z";
const flow: FlowDefinition = { id: "flow:1", name: "Review", description: "", workspaceId: "workspace:1", status: "published", version: 1, trigger: { kind: "manual" }, steps: [{ id: "step:1", name: "Inspect", kind: "agent", actorId: "agent:claude", prompt: "Inspect", dependsOn: [], condition: "always", timeoutMs: 1000, maxAttempts: 2 }], permissionCeiling: ["repository-read"], createdAt: now, updatedAt: now };
const run: FlowRun = { id: "run:1", flowId: flow.id, flowVersion: 1, phase: "running", triggerKind: "manual", flowSnapshot: flow, currentStepIds: [], completedStepIds: [], failedStepIds: [], createdAt: now, updatedAt: now };
function event(eventType: EventEnvelope["eventType"], payload: unknown): EventEnvelope { return { eventId: `${eventType}:${Math.random()}`, eventType, aggregateType: "run", aggregateId: run.id, aggregateVersion: 1, actorId: "system", correlationId: run.id, causationId: null, occurredAt: now, idempotencyKey: `${eventType}:${Math.random()}`, payload }; }

describe("Flow Task compatibility projection", () => {
  it("materializes a first-class Task and Attempt from existing Flow runtime events", () => {
    let projection = reduceProjection(emptyProjection(), event("FlowDefinitionEvent", { flow }));
    projection = reduceProjection(projection, event("FlowRuntimeEvent", { run }));
    const stepRun: StepRun = { id: "step-run:1", flowRunId: run.id, stepId: "step:1", actorId: "agent:claude", phase: "running", selectedDependencyStepRunIds: [], message: "Running", createdAt: now, updatedAt: now };
    projection = reduceProjection(projection, event("CollaborationRuntimeEvent", { change: { kind: "step-run", entity: stepRun } }));
    const attempt: StepAttempt = { id: "attempt:1", stepRunId: stepRun.id, ordinal: 1, phase: "running", requestedActorId: "agent:claude", agentSessionId: "session:1", permissionLeaseId: "lease:1", startedAt: now };
    projection = reduceProjection(projection, event("CollaborationRuntimeEvent", { change: { kind: "step-attempt", entity: attempt } }));
    expect(projection.tasks["task:flow:run:1:step:1"]).toMatchObject({ title: "Inspect", status: "running", source: { kind: "flow", flowRunId: "run:1" } });
    expect(projection.taskAttempts["task-attempt:attempt:1"]).toMatchObject({ taskId: "task:flow:run:1:step:1", workerSessionId: "session:1", permissionLeaseId: "lease:1" });
  });
});
