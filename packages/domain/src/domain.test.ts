import { describe, expect, it } from "vitest";
import {
  ChangeOperationSchema,
  DomainInvariantError,
  applyOperations,
  assertGraphInvariants,
  assertWorkTransition,
  classifyDiff,
  emptyGraph,
  legacyAgentProfileToWorker,
  legacyAgentSpecToWorker,
  WorkerSpecVersionSchema,
  type GraphNode,
  type WeaveDiff,
} from "./index.js";

const now = "2026-08-03T00:00:00.000Z";

function actor(id: string, kind: "human" | "agent"): GraphNode {
  return { id, name: id, type: "actor", kind, status: "online", createdAt: now, updatedAt: now };
}

function diff(): WeaveDiff {
  return {
    id: "mutation-1",
    baseGraphVersion: 0,
    originatorActorId: "human-1",
    sourceMessageId: "message-1",
    intentSummary: "Fix CSV export",
    workTitle: "Fix CSV export",
    acceptanceCriteria: ["tests pass"],
    executionDraft: {
      executorActorId: "claude-1",
      repositoryId: "repo-1",
      testCommandId: "test-1",
      requiredEvidence: ["patch", "test-report", "execution-summary"],
    },
    stewardExplanation: "Create a run and grant scoped write access.",
    operations: [
      {
        operationId: "op-work",
        op: "add_node",
        explanation: "Create the work",
        node: {
          id: "work-1",
          name: "Fix CSV export",
          type: "work",
          kind: "run",
          description: "Fix it",
          status: "proposed",
          acceptanceCriteria: ["tests pass"],
          risk: "red",
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        operationId: "op-executor",
        op: "add_edge",
        explanation: "Assign Claude",
        edge: { id: "edge-executor", type: "assignment", from: "claude-1", to: "work-1", role: "executor" },
      },
      {
        operationId: "op-auth",
        op: "add_edge",
        explanation: "Grant run-scoped write access",
        edge: { id: "edge-auth", type: "authorization", from: "claude-1", to: "repo-write", scope: "run-1" },
      },
    ],
  };
}

describe("risk classification", () => {
  it("recomputes a red aggregate when repository authorization is present", () => {
    const result = classifyDiff(diff());
    expect(result.operations).toEqual({ "op-work": "green", "op-executor": "yellow", "op-auth": "red" });
    expect(result.aggregate).toBe("red");
  });
});

describe("ChangeOperation payload contracts", () => {
  it("rejects a create-flow draft that cannot be materialized", () => {
    const result = ChangeOperationSchema.safeParse({
      id: "op-create-flow",
      kind: "create-flow",
      dependsOn: [],
      payload: { description: "missing the required flow name" },
    });

    expect(result.success).toBe(false);
  });

  it("accepts a plan-shaped create-flow while leaving host-owned fields optional", () => {
    const result = ChangeOperationSchema.safeParse({
      id: "op-create-flow",
      kind: "create-flow",
      dependsOn: [],
      payload: {
        name: "Daily repository review",
        workspaceId: "workspace:demo",
        trigger: { kind: "schedule", intervalMs: 86_400_000, timeOfDay: "08:30", timezone: "Asia/Shanghai" },
        steps: [{ id: "review", name: "Review changes", kind: "agent", actorId: "worker:reviewer", dependsOn: [] }],
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts graph-node drafts without ids and rejects host-owned fields in Flow patches", () => {
    expect(ChangeOperationSchema.safeParse({
      id: "create-capability", kind: "create-graph-node", dependsOn: [],
      payload: { name: "Repository read", type: "capability", kind: "repository-read", scope: "workspace:demo", constraints: {} },
    }).success).toBe(true);

    expect(ChangeOperationSchema.safeParse({
      id: "update-flow", kind: "update-flow", targetId: "flow:daily", dependsOn: [],
      payload: { patch: { id: "flow:other", status: "published", description: "unsafe" } },
    }).success).toBe(false);
  });

  it("rejects invalid nested Flow step fields instead of accepting raw payload data", () => {
    expect(ChangeOperationSchema.safeParse({
      id: "create-flow", kind: "create-flow", dependsOn: [],
      payload: { name: "Unsafe", steps: [{ id: "review", name: "Review", actorId: "agent:claude", join: { mode: "bogus" }, requiredCapabilities: [1] }] },
    }).success).toBe(false);
  });
});

describe("graph invariants", () => {
  it("rejects an Agent as owner", () => {
    expect(() =>
      assertGraphInvariants(
        [actor("claude", "agent"), {
          id: "work",
          name: "work",
          type: "work",
          kind: "run",
          description: "",
          status: "proposed",
          acceptanceCriteria: ["done"],
          risk: "green",
          createdAt: now,
          updatedAt: now,
        }],
        [{ id: "owner", type: "assignment", from: "claude", to: "work", role: "owner" }],
      ),
    ).toThrow(DomainInvariantError);
  });

  it("applies validated operations and increments graph version", () => {
    const graph = applyOperations(emptyGraph(), [
      { operationId: "add-human", op: "add_node", explanation: "seed", node: actor("human", "human") },
      { operationId: "add-agent", op: "add_node", explanation: "seed", node: actor("claude", "agent") },
    ]);
    expect(graph.version).toBe(1);
    expect(graph.nodes).toHaveLength(2);
  });
});

describe("Work state machine", () => {
  it("allows evidence review before completion", () => {
    expect(() => assertWorkTransition("running", "awaiting_acceptance")).not.toThrow();
    expect(() => assertWorkTransition("awaiting_acceptance", "completed")).not.toThrow();
  });

  it("rejects executor self-completion", () => {
    expect(() => assertWorkTransition("running", "completed")).toThrow("illegal Work transition");
  });
});

describe("WorkerSpec v2", () => {
  const input = {
    schemaVersion: 2 as const,
    id: "worker-spec:reviewer:v2",
    workerId: "worker:reviewer",
    version: 2,
    engine: { adapter: "claude-code" as const, model: "sonnet", effort: "medium" },
    systemPrompt: "Review changes and return evidence.",
    skills: [{ name: "review", content: "Review against acceptance criteria.", enabled: true, checksum: "a".repeat(64) }],
    mcpServers: [{ name: "github", transport: "http" as const, url: "https://mcp.example.test", env: { GITHUB_TOKEN: { secretRef: "secret:github" } }, allowedTools: ["search"], enabled: true }],
    tools: [{ name: "Read", source: "builtin" as const, permission: "read" as const, enabled: true }],
    fileRefs: ["README.md"],
    knowledgeRefs: [],
    memory: { scope: "task" as const, resume: true, summaryPolicy: "rolling" as const },
    sessionPolicy: { maxTurns: 20, timeoutMs: 300_000, maxConcurrentSessions: 1 },
    budget: { maxCostUsd: 2 },
    orchestration: { enabled: false, maxDelegationDepth: 0, maxFanOut: 0, allowedWorkerKinds: [] },
    lifecycle: "persistent" as const,
    createdBy: "human:owner",
    createdAt: now,
  };

  it("accepts an inline harness with SecretRef-only sensitive MCP values", () => {
    expect(WorkerSpecVersionSchema.parse(input)).toMatchObject({ workerId: "worker:reviewer", schemaVersion: 2 });
  });

  it("rejects plaintext sensitive MCP values and shell-style stdio commands", () => {
    const plaintext = structuredClone(input);
    plaintext.mcpServers[0] = { ...plaintext.mcpServers[0]!, env: { GITHUB_TOKEN: { value: "plaintext" } } } as never;
    expect(() => WorkerSpecVersionSchema.parse(plaintext)).toThrow(/SecretRef/);

    const shell = structuredClone(input);
    shell.mcpServers = [{ name: "unsafe", transport: "stdio", command: "node server.js && touch /tmp/x", args: [], env: {}, allowedTools: [], enabled: true }] as never;
    expect(() => WorkerSpecVersionSchema.parse(shell)).toThrow(/shell/i);
  });

  it("maps legacy Agent profiles and specs to conservative Worker views", () => {
    const worker = legacyAgentProfileToWorker({
      id: "agent:reviewer", name: "Reviewer", source: "graph-native", adapterKind: "claude-code", status: "online", capabilities: ["Read", "structured-output"], contractLevel: "control", lifecycle: "persistent", specVersionId: "agent-spec:v1", registeredAt: now, updatedAt: now,
    });
    const spec = legacyAgentSpecToWorker({
      id: "agent-spec:v1", agentId: "agent:reviewer", version: 1, engine: "claude-code", prompt: "Review", skills: ["review"], tools: ["Read"], fileRefs: [], lifecycle: "persistent", memoryPolicy: "session", maxTurns: 10, maxBudgetUsd: 1, canOrchestrate: false, maxDelegationDepth: 0, maxFanOut: 0, createdAt: now,
    });
    expect(worker).toMatchObject({ id: "agent:reviewer", source: "native", defaultSpecVersionId: "agent-spec:v1" });
    expect(worker.controlCapabilities).toMatchObject({ cancel: true, structuredOutput: true });
    expect(spec).toMatchObject({ schemaVersion: 1, workerId: "agent:reviewer", legacySkillRefs: ["review"] });
  });
});
