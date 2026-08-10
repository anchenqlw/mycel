import type {
  AgentStepExecutionResult,
  CollaborationChange,
  FlowDefinition,
  FlowRun,
  FlowStepDefinition,
  HumanTask,
} from "@mycel/domain";
import { describe, expect, it } from "vitest";
import { LocalFlowEngine, type AgentStepInput, type FlowEnginePort } from "./flow-engine.js";

class FakePort implements FlowEnginePort {
  definitions: FlowDefinition[] = [];
  runs: FlowRun[] = [];
  changes: CollaborationChange[] = [];
  attempts = new Map<string, number>();
  outcomes = new Map<string, AgentStepExecutionResult[]>();
  delays = new Map<string, number>();
  startedAt = new Map<string, number>();
  inputs = new Map<string, AgentStepInput>();

  async persistDefinition(flow: FlowDefinition) { this.definitions.push(flow); }
  async persistRun(run: FlowRun) { this.runs.push(structuredClone(run)); }
  async persistCollaboration(change: CollaborationChange) { this.changes.push(structuredClone(change)); }
  actorCapabilities() { return ["repository-read", "repository-write"]; }
  actorCapacity() { return 4; }
  async executeAgentStep(input: AgentStepInput) {
    const count = (this.attempts.get(input.step.id) ?? 0) + 1;
    this.attempts.set(input.step.id, count);
    this.startedAt.set(input.step.id, Date.now());
    this.inputs.set(input.step.id, input);
    await new Promise((resolve) => setTimeout(resolve, this.delays.get(input.step.id) ?? 1));
    return this.outcomes.get(input.step.id)?.[count - 1] ?? { status: "completed" as const, summary: `${input.step.id} completed`, output: { step: input.step.id } };
  }

  latestHumanTask(): HumanTask {
    const change = [...this.changes].reverse().find((item): item is Extract<CollaborationChange, { kind: "human-task" }> => item.kind === "human-task");
    if (!change) throw new Error("human task missing");
    return change.entity;
  }
}

function draft(steps: FlowStepDefinition[]) {
  return {
    id: "flow:test",
    name: "Test flow",
    description: "A versioned collaboration graph",
    status: "draft" as const,
    version: 0,
    trigger: { kind: "manual" as const },
    steps,
    permissionCeiling: ["repository-read", "repository-write"],
    maxConcurrency: 4,
    budget: { maxRuntimeMs: 60_000, maxTotalAttempts: 20 },
  };
}

function step(
  id: string,
  dependsOn: string[] = [],
  options: Partial<FlowStepDefinition> = {},
): FlowStepDefinition {
  return {
    id,
    name: id,
    kind: "agent",
    actorId: `agent:${id}`,
    prompt: id,
    dependsOn,
    condition: "always",
    timeoutMs: 1_000,
    maxAttempts: 2,
    join: { mode: "all" },
    requiredCapabilities: ["repository-read"],
    ...options,
  };
}

describe("LocalFlowEngine collaboration runtime", () => {
  it("uses an injected clock for persisted flow timestamps", async () => {
    let now = "2027-04-20T14:30:00.000Z";
    const port = new FakePort();
    const engine = new LocalFlowEngine(port, { now: () => new Date(now) });

    const saved = await engine.save(draft([step("inspect")]));
    now = "2027-04-20T14:32:00.000Z";
    const published = await engine.publish(saved.id);

    expect(saved).toMatchObject({ createdAt: "2027-04-20T14:30:00.000Z", updatedAt: "2027-04-20T14:30:00.000Z" });
    expect(published).toMatchObject({ createdAt: "2027-04-20T14:30:00.000Z", updatedAt: "2027-04-20T14:32:00.000Z" });
  });

  it("runs independent steps concurrently and passes durable dependency results downstream", async () => {
    const port = new FakePort();
    port.delays.set("research", 30);
    port.delays.set("inspect", 30);
    const engine = new LocalFlowEngine(port);
    await engine.save(draft([step("research"), step("inspect"), step("synthesize", ["research", "inspect"], { condition: "previous-succeeded" })]));
    await engine.publish("flow:test");
    await engine.trigger("flow:test");
    await engine.waitForIdle();

    expect(Math.abs(port.startedAt.get("research")! - port.startedAt.get("inspect")!)).toBeLessThan(20);
    expect(port.inputs.get("synthesize")?.dependencyResults.map((item) => item.summary)).toEqual(["research completed", "inspect completed"]);
    expect(port.runs.at(-1)?.phase).toBe("completed");
  });

  it("creates a Human Inbox task and automatically resumes after the claimed task is completed", async () => {
    const port = new FakePort();
    const human = step("approve", ["analyze"], { kind: "human", actorId: "human:reviewer", prompt: "Review the analysis" });
    const engine = new LocalFlowEngine(port);
    await engine.save(draft([step("analyze"), human, step("publish", ["approve"], { condition: "previous-succeeded" })]));
    await engine.publish("flow:test");
    const run = await engine.trigger("flow:test");
    await engine.waitForIdle();
    expect(port.runs.at(-1)?.phase).toBe("blocked");

    const task = port.latestHumanTask();
    expect(task.assignedActorId).toBe("human:reviewer");
    await engine.claimHumanTask(task.id, "human:reviewer", "test:claim");
    await engine.completeHumanTask(task.id, "human:reviewer", { summary: "Approved", output: { decision: "go" } }, "test:complete");
    await engine.waitForIdle();

    expect(engine.details(run.id).runs[0]?.phase).toBe("completed");
    expect(port.inputs.get("publish")?.dependencyResults[0]?.output).toEqual({ decision: "go" });
  });

  it("supports any, quorum, and race joins while retaining retries", async () => {
    const port = new FakePort();
    port.outcomes.set("a", [{ status: "failed", summary: "a failed" }, { status: "completed", summary: "a recovered" }]);
    port.delays.set("slow", 50);
    port.delays.set("fast", 5);
    const engine = new LocalFlowEngine(port);
    await engine.save(draft([
      step("a"),
      step("b"),
      step("c"),
      step("any", ["a", "b"], { condition: "previous-succeeded", join: { mode: "any" } }),
      step("quorum", ["a", "b", "c"], { condition: "previous-succeeded", join: { mode: "quorum", quorum: 2 } }),
      step("slow"),
      step("fast"),
      step("race", ["slow", "fast"], { join: { mode: "race" } }),
    ]));
    await engine.publish("flow:test");
    await engine.trigger("flow:test");
    await engine.waitForIdle();

    expect(port.attempts.get("a")).toBe(2);
    expect(port.inputs.get("any")?.dependencyResults).toHaveLength(1);
    expect(port.inputs.get("quorum")?.dependencyResults).toHaveLength(2);
    expect(port.inputs.get("race")?.dependencyResults[0]?.summary).toBe("fast completed");
    expect(port.runs.at(-1)?.phase).toBe("completed");
  });

  it("restores a blocked run without duplicating completed steps or its open Human Task", async () => {
    const firstPort = new FakePort();
    const human = step("approval", ["analysis"], { kind: "human", actorId: "human:owner" });
    const firstEngine = new LocalFlowEngine(firstPort);
    await firstEngine.save(draft([step("analysis"), human, step("finish", ["approval"])]));
    const published = await firstEngine.publish("flow:test");
    const run = await firstEngine.trigger("flow:test");
    await firstEngine.waitForIdle();
    const snapshot = firstEngine.details(run.id);
    expect(firstPort.attempts.get("analysis")).toBe(1);

    const restoredPort = new FakePort();
    const restored = new LocalFlowEngine(restoredPort);
    restored.restore([published], snapshot);
    await restored.waitForIdle();
    expect(restored.details(run.id).humanTasks).toHaveLength(1);
    expect(restoredPort.attempts.get("analysis")).toBeUndefined();

    const task = restored.details(run.id).humanTasks[0]!;
    await restored.claimHumanTask(task.id, "human:owner", "restore:claim");
    await restored.completeHumanTask(task.id, "human:owner", { summary: "Approved after restart" }, "restore:complete");
    await restored.waitForIdle();
    expect(restored.details(run.id).runs[0]?.phase).toBe("completed");
  });

  it("rejects cyclic graphs and invalid quorum definitions", async () => {
    const engine = new LocalFlowEngine(new FakePort());
    await expect(engine.save(draft([step("a", ["b"]), step("b", ["a"])]))).rejects.toThrow("acyclic");
    await expect(engine.save(draft([step("a"), step("b", ["a"], { join: { mode: "quorum", quorum: 2 } })]))).rejects.toThrow("quorum");
  });
});
