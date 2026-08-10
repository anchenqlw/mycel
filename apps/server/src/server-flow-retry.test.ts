import type { AgentStepExecutionResult, CollaborationChange, FlowDefinition, FlowRun } from "@mycel/domain";
import { LocalFlowEngine, type AgentStepInput, type FlowEnginePort } from "@mycel/flow-engine";
import { afterEach, describe, expect, it } from "vitest";
import type { MycelRuntime } from "./runtime.js";
import { buildServer } from "./server.js";

class RetryPort implements FlowEnginePort {
  attempts = 0;

  async persistDefinition(_flow: FlowDefinition) {}
  async persistRun(_run: FlowRun, _message: string) {}
  async persistCollaboration(_change: CollaborationChange, _message: string, _idempotencyKey: string) {}
  actorCapabilities() { return ["repository-read"]; }
  actorCapacity() { return 1; }
  async executeAgentStep(_input: AgentStepInput): Promise<AgentStepExecutionResult> {
    this.attempts += 1;
    return { status: "failed", summary: "Local adapter unavailable" };
  }
}

const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Flow retry HTTP recovery", () => {
  it("reopens a failed run and dispatches another attempt through the retry endpoint", async () => {
    const port = new RetryPort();
    const engine = new LocalFlowEngine(port);
    await engine.save({
      id: "flow:retry-http",
      name: "Retry HTTP",
      description: "Exercise failed step recovery",
      status: "draft",
      version: 0,
      trigger: { kind: "manual" },
      steps: [{
        id: "publish",
        name: "Record readiness",
        kind: "agent",
        actorId: "agent:local",
        prompt: "Record readiness",
        dependsOn: [],
        condition: "always",
        timeoutMs: 1_000,
        maxAttempts: 1,
        join: { mode: "all" },
        requiredCapabilities: ["repository-read"],
      }],
      permissionCeiling: ["repository-read"],
      maxConcurrency: 1,
      budget: { maxRuntimeMs: 60_000, maxTotalAttempts: 4 },
    });
    await engine.publish("flow:retry-http");
    const run = await engine.trigger("flow:retry-http");
    await engine.waitForIdle();
    const failed = engine.details(run.id);
    const stepRun = failed.stepRuns[0]!;
    expect({ phase: failed.runs[0]?.phase, attempts: failed.runs[0]?.totalAttempts, step: stepRun.phase }).toEqual({ phase: "failed", attempts: 1, step: "failed" });

    const server = await buildServer({ control: { flowEngine: engine } } as unknown as MycelRuntime);
    servers.push(server);
    const response = await server.inject({ method: "POST", url: `/api/step-runs/${encodeURIComponent(stepRun.id)}/retry` });
    expect(response.statusCode).toBe(200);
    await engine.waitForIdle();

    const retried = engine.details(run.id);
    expect({ phase: retried.runs[0]?.phase, attempts: retried.runs[0]?.totalAttempts, step: retried.stepRuns[0]?.phase, portAttempts: port.attempts }).toEqual({
      phase: "failed",
      attempts: 2,
      step: "failed",
      portAttempts: 2,
    });
    expect(retried.stepAttempts.map((attempt) => ({ ordinal: attempt.ordinal, phase: attempt.phase }))).toEqual([
      { ordinal: 1, phase: "failed" },
      { ordinal: 2, phase: "failed" },
    ]);
    expect(retried.stepResults.map((result) => ({ attemptId: result.attemptId, status: result.status }))).toEqual([
      { attemptId: retried.stepAttempts[0]?.id, status: "failed" },
      { attemptId: retried.stepAttempts[1]?.id, status: "failed" },
    ]);
  });

  it("leaves a budget-exhausted failed step actionable instead of reopening it into ready", async () => {
    const port = new RetryPort();
    const engine = new LocalFlowEngine(port);
    await engine.save({
      id: "flow:retry-budget",
      name: "Retry budget",
      description: "Keep exhausted recovery actionable",
      status: "draft",
      version: 0,
      trigger: { kind: "manual" },
      steps: [{
        id: "publish",
        name: "Record readiness",
        kind: "agent",
        actorId: "agent:local",
        prompt: "Record readiness",
        dependsOn: [],
        condition: "always",
        timeoutMs: 1_000,
        maxAttempts: 1,
        join: { mode: "all" },
        requiredCapabilities: ["repository-read"],
      }],
      permissionCeiling: ["repository-read"],
      maxConcurrency: 1,
      budget: { maxRuntimeMs: 60_000, maxTotalAttempts: 1 },
    });
    await engine.publish("flow:retry-budget");
    const run = await engine.trigger("flow:retry-budget");
    await engine.waitForIdle();
    const failed = engine.details(run.id);
    const stepRun = failed.stepRuns[0]!;

    const server = await buildServer({ control: { flowEngine: engine } } as unknown as MycelRuntime);
    servers.push(server);
    const response = await server.inject({ method: "POST", url: `/api/step-runs/${encodeURIComponent(stepRun.id)}/retry` });
    expect(response.statusCode).toBe(500);
    await engine.waitForIdle();

    const unchanged = engine.details(run.id);
    expect({ phase: unchanged.runs[0]?.phase, attempts: unchanged.runs[0]?.totalAttempts, step: unchanged.stepRuns[0]?.phase, portAttempts: port.attempts }).toEqual({
      phase: "failed",
      attempts: 1,
      step: "failed",
      portAttempts: 1,
    });
  });
});
