import { describe, expect, it } from "vitest";
import { createEvent, type AgentProfile, type AgentSession, type AgentSpec } from "@mycel/domain";
import { emptyProjection, reduceProjection } from "./projection.js";

const occurredAt = "2026-08-05T00:00:00.000Z";

function event(eventType: "AgentRuntimeEvent" | "AgentSessionEvent", payload: unknown) {
  return createEvent({
    eventId: `event:${eventType}`,
    eventType,
    aggregateType: "system",
    aggregateId: "agent:legacy",
    aggregateVersion: 1,
    actorId: "system:test",
    correlationId: "test:worker-compat",
    causationId: null,
    occurredAt,
    idempotencyKey: `test:${eventType}`,
    payload,
  });
}

describe("Worker compatibility projection", () => {
  it("projects legacy Agent runtime and session events into Worker views", () => {
    const profile: AgentProfile = { id: "agent:legacy", name: "Legacy", source: "graph-native", adapterKind: "claude-code", status: "online", capabilities: ["Read"], contractLevel: "control", lifecycle: "persistent", specVersionId: "spec:legacy:v1", registeredAt: occurredAt, updatedAt: occurredAt };
    const spec: AgentSpec = { id: "spec:legacy:v1", agentId: profile.id, version: 1, engine: "claude-code", prompt: "Inspect", skills: [], tools: ["Read"], fileRefs: [], lifecycle: "persistent", memoryPolicy: "session", maxTurns: 10, maxBudgetUsd: 1, canOrchestrate: false, maxDelegationDepth: 0, maxFanOut: 0, createdAt: occurredAt };
    const session: AgentSession = { id: "session:legacy", agentId: profile.id, adapterKind: "claude-code", specVersionId: spec.id, phase: "completed", mode: "explore", prompt: "Inspect", summary: "Done", lastEvent: "Completed", createdAt: occurredAt, updatedAt: occurredAt };

    const withProfile = reduceProjection(emptyProjection(), event("AgentRuntimeEvent", { profile, spec }));
    const withSession = reduceProjection(withProfile, event("AgentSessionEvent", { session }));

    expect(withSession.workers[profile.id]).toMatchObject({ source: "native", defaultSpecVersionId: spec.id });
    expect(withSession.workerSpecs[spec.id]).toMatchObject({ schemaVersion: 1, workerId: profile.id });
    expect(withSession.workerSessions[session.id]).toMatchObject({ workerId: profile.id, workerSpecVersionId: spec.id, phase: "completed" });
    expect(withSession.agents[profile.id]).toEqual(profile);
    expect(withSession.agentSessions[session.id]).toEqual(session);
  });
});
