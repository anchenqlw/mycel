import { describe, expect, it } from "vitest";
import type { ChangeOperation } from "@mycel/domain";
import {
  materializeCreateFlow,
  materializeUpdateFlow,
  materializeGraphEdge,
  materializeGraphNode,
  resolveFlowTarget,
  validateMaterializableChange,
  type ChangeMaterializationContext,
} from "./change-operation-materializer.js";

const context: ChangeMaterializationContext = {
  changeSetId: "changeset:daily-review",
  now: "2026-08-10T12:00:00.000Z",
  actors: new Map([
    ["owner", { id: "human:owner", kind: "human" }],
    ["reviewer", { id: "agent:claude", kind: "agent" }],
  ]),
  workspaces: new Map([["repository", "workspace:demo"]]),
  flows: new Map(),
  graphNodeIds: new Set(["human:owner", "agent:claude"]),
};

describe("ChangeOperation materialization", () => {
  it("turns a plan-shaped Flow into a complete host-owned Flow draft", () => {
    const operation: ChangeOperation = {
      id: "create-flow",
      kind: "create-flow",
      dependsOn: [],
      payload: {
        name: "Daily repository review",
        description: "Review recent repository changes",
        workspaceRef: "repository",
        trigger: { kind: "schedule", intervalMs: 86_400_000, timeOfDay: "08:30", timezone: "Asia/Shanghai" },
        steps: [
          { id: "review", name: "Review changes", actorRef: "reviewer", prompt: "Review changes", dependsOn: [] },
          { id: "approve", name: "Owner approval", actorRef: "owner", prompt: "Approve the report", dependsOn: ["review"] },
        ],
      },
    };

    expect(materializeCreateFlow(operation, context)).toEqual(expect.objectContaining({
      id: "flow:changeset:daily-review:create-flow",
      name: "Daily repository review",
      workspaceId: "workspace:demo",
      status: "draft",
      version: 0,
      createdAt: context.now,
      updatedAt: context.now,
      trigger: expect.objectContaining({ timeOfDay: "08:30", timezone: "Asia/Shanghai" }),
      steps: [
        expect.objectContaining({ id: "review", actorId: "agent:claude", kind: "agent" }),
        expect.objectContaining({ id: "approve", actorId: "human:owner", kind: "human" }),
      ],
    }));
    expect(JSON.stringify(materializeCreateFlow(operation, context))).not.toContain("undefined");
  });

  it("resolves the exact ProductionPlan actor and workspace aliases emitted by Steward", () => {
    const operation: ChangeOperation = {
      id: "op-create-flow",
      kind: "create-flow",
      dependsOn: [],
      payload: {
        name: "Daily knowledge health check",
        trigger: { kind: "schedule", intervalMs: 86_400_000, timeOfDay: "08:30", timezone: "Asia/Shanghai" },
        actors: [
          { id: "actor-worker", existingActorId: "agent:claude", kind: "adopted-agent", name: "Claude Code" },
          { id: "actor-owner", existingActorId: "human:owner", kind: "human", name: "Owner" },
        ],
        workspaces: [{ id: "ws-demo", workspaceId: "workspace:demo", purpose: "fictional test workspace", access: "write" }],
        steps: [
          { id: "inspect", name: "Inspect", actorId: "actor-worker", workspaceIds: ["ws-demo"], dependsOn: [], prompt: "Inspect" },
          { id: "review", name: "Review", actorId: "actor-owner", workspaceIds: ["ws-demo"], dependsOn: ["inspect"], prompt: "Review" },
        ],
      },
    };

    expect(materializeCreateFlow(operation, context)).toMatchObject({
      workspaceId: "workspace:demo",
      steps: [
        expect.objectContaining({ actorId: "agent:claude", kind: "agent" }),
        expect.objectContaining({ actorId: "human:owner", kind: "human" }),
      ],
    });
  });

  it("adds host timestamps to graph nodes without allowing caller overrides", () => {
    const operation: ChangeOperation = {
      id: "create-capability",
      kind: "create-graph-node",
      dependsOn: [],
      payload: {
        id: "cap:repo-read:demo",
        name: "Repository read",
        type: "capability",
        kind: "repository-read",
        scope: "workspace:demo",
        constraints: {},
        createdAt: "2020-01-01T00:00:00.000Z",
      },
    };

    expect(materializeGraphNode(operation, context)).toMatchObject({
      id: "cap:repo-read:demo",
      createdAt: context.now,
      updatedAt: context.now,
    });
  });

  it("derives a graph node id and overrides caller lifecycle state", () => {
    const operation: ChangeOperation = {
      id: "create-work",
      kind: "create-graph-node",
      dependsOn: [],
      payload: {
        name: "Review result",
        type: "work",
        kind: "flow",
        description: "Review the generated report",
        status: "completed",
        archivedAt: "2020-01-01T00:00:00.000Z",
        acceptanceCriteria: ["Owner accepted"],
        risk: "yellow",
      },
    };

    expect(materializeGraphNode(operation, context)).toMatchObject({
      id: "node:changeset:daily-review:create-work",
      status: "proposed",
      createdAt: context.now,
      updatedAt: context.now,
    });
    expect(materializeGraphNode(operation, context)).not.toHaveProperty("archivedAt");
  });

  it("host-defaults Actor lifecycle even when the caller supplies an archived state", () => {
    const operation: ChangeOperation = {
      id: "create-actor", kind: "create-graph-node", dependsOn: [],
      payload: { name: "Reviewer", type: "actor", kind: "agent", status: "offline", lifecycle: "archived" },
    };
    expect(materializeGraphNode(operation, context)).toMatchObject({ status: "online", lifecycle: "persistent" });
  });

  it("merges an update-flow patch without accepting host-owned identity or lifecycle", () => {
    const existing = materializeCreateFlow({
      id: "existing",
      kind: "create-flow",
      dependsOn: [],
      payload: { name: "Existing", steps: [{ id: "review", name: "Review", actorRef: "reviewer" }] },
    }, context);
    const updateContext = { ...context, flows: new Map([[existing.id, { ...existing, status: "published" as const, version: 3 }]]) };
    const operation: ChangeOperation = {
      id: "update",
      kind: "update-flow",
      targetId: existing.id,
      dependsOn: [],
      payload: { patch: { description: "Updated safely" } },
    };

    expect(materializeUpdateFlow(operation, updateContext)).toMatchObject({
      id: existing.id,
      status: "published",
      version: 4,
      description: "Updated safely",
      createdAt: existing.createdAt,
    });
  });

  it("resolves publish-flow through a prior operation result", () => {
    expect(resolveFlowTarget({ id: "publish", kind: "publish-flow", dependsOn: ["create-flow"], payload: { flowRef: "create-flow" } }, {
      "create-flow": { id: "flow:changeset:daily-review:create-flow" },
    })).toBe("flow:changeset:daily-review:create-flow");
  });

  it("normalizes Steward capability permissions and prior-operation edge references", () => {
    const operation: ChangeOperation = {
      id: "authorize-worker",
      kind: "create-graph-edge",
      dependsOn: ["create-capability"],
      payload: {
        edge: {
          id: "edge:worker-read",
          type: "authorization",
          from: "agent:claude",
          toRef: "create-capability",
          permission: "repository-read",
          scope: "workspace:demo",
        },
      },
    };

    expect(materializeGraphEdge(operation, context, {
      "create-capability": { id: "cap:repo-read:demo" },
    })).toEqual(expect.objectContaining({
      id: "edge:worker-read",
      from: "agent:claude",
      to: "cap:repo-read:demo",
      permission: "read",
    }));
  });

  it("rejects unresolved actors during proposal preflight", () => {
    const operation: ChangeOperation = {
      id: "create-flow",
      kind: "create-flow",
      dependsOn: [],
      payload: {
        name: "Invalid flow",
        steps: [{ id: "review", name: "Review", actorRef: "missing", dependsOn: [] }],
      },
    };

    expect(() => validateMaterializableChange(operation, context, [operation])).toThrow(/create-flow.*actor/i);
  });

  it("rejects cross-operation references that are missing an explicit dependency", () => {
    const createNode: ChangeOperation = {
      id: "create-capability",
      kind: "create-graph-node",
      dependsOn: [],
      payload: { name: "Read", type: "capability", kind: "repository-read", scope: "workspace:demo", constraints: {} },
    };
    const createEdge: ChangeOperation = {
      id: "authorize",
      kind: "create-graph-edge",
      dependsOn: [],
      payload: { type: "authorization", from: "agent:claude", toRef: "create-capability", permission: "read" },
    };
    expect(() => validateMaterializableChange(createEdge, context, [createNode, createEdge])).toThrow(/depend/i);
  });

  it("rejects publish-flow references to the wrong operation kind before approval", () => {
    const createNode: ChangeOperation = {
      id: "create-node",
      kind: "create-graph-node",
      dependsOn: [],
      payload: { name: "Read", type: "capability", kind: "repository-read", scope: "workspace:demo", constraints: {} },
    };
    const publish: ChangeOperation = { id: "publish", kind: "publish-flow", dependsOn: ["create-node"], payload: { flowRef: "create-node" } };
    expect(() => validateMaterializableChange(publish, context, [createNode, publish])).toThrow(/create-flow/i);
  });

  it("rejects invalid timezone and cyclic Flow drafts before approval", () => {
    const operation: ChangeOperation = {
      id: "create-flow",
      kind: "create-flow",
      dependsOn: [],
      payload: {
        name: "Invalid flow",
        trigger: { kind: "schedule", intervalMs: 86_400_000, timeOfDay: "08:30", timezone: "Mars/Olympus" },
        steps: [
          { id: "first", name: "First", actorId: "reviewer", dependsOn: ["second"] },
          { id: "second", name: "Second", actorId: "reviewer", dependsOn: ["first"] },
        ],
      },
    };

    expect(() => validateMaterializableChange(operation, context, [operation])).toThrow(/timezone|cyclic/i);
  });

  it("rejects an invalid quorum join before approval", () => {
    const operation: ChangeOperation = {
      id: "create-flow", kind: "create-flow", dependsOn: [],
      payload: {
        name: "Invalid quorum",
        steps: [
          { id: "a", name: "A", actorId: "reviewer" },
          { id: "b", name: "B", actorId: "reviewer", dependsOn: ["a"], join: { mode: "quorum", quorum: 2 } },
        ],
      },
    };
    expect(() => validateMaterializableChange(operation, context, [operation])).toThrow(/quorum/i);
  });
});
