import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "@mycel/ledger-sqlite";
import { ControlPlane } from "./control-plane.js";
import { analyzeChangeSet, orderChangeOperations } from "./impact-analyzer.js";
import { resolveControlResource } from "./resource-resolver.js";
import { classifyChangeSetRisk, classifyCommandRisk } from "./risk-policy.js";
import { emptyProjection, reduceProjection } from "./projection.js";
import type { ChangeSet, ControlCommand } from "@mycel/domain";

const now = "2026-08-05T00:00:00.000Z";

function command(overrides: Partial<ControlCommand> = {}): ControlCommand {
  return {
    schemaVersion: 1, id: "command:1", action: "cancel-worker-session",
    target: { kind: "worker-session", id: "session:1", label: "Review session" }, arguments: {},
    contextVersion: 1, initiatedBy: "human:owner", sourceMessageId: "message:1", idempotencyKey: "command:1",
    status: "planned", createdAt: now, updatedAt: now, ...overrides,
  };
}

function changeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    schemaVersion: 1, id: "changeset:1", title: "Publish reviewer", intentSummary: "Publish reviewer harness",
    operations: [{ id: "op:1", kind: "publish-worker-spec", targetId: "worker:reviewer", dependsOn: [], payload: { lifecycle: "persistent" } }],
    preconditions: [], impact: { resourcesCreated: [], resourcesModified: [], resourcesArchived: [], permissionsAdded: [], runtimeEffects: [], warnings: [] },
    aggregateRisk: "red", status: "draft", operationResults: [], contextVersion: 1, initiatedBy: "human:owner",
    sourceMessageId: "message:1", idempotencyKey: "changeset:1", createdAt: now, updatedAt: now, ...overrides,
  };
}

describe("unified Control Plane", () => {
  it("resolves exact resources and returns candidates for ambiguous names", () => {
    const projection = emptyProjection();
    projection.workers["worker:1"] = { schemaVersion: 2, id: "worker:1", name: "Reviewer", source: "native", adapterKind: "claude-code", status: "online", capabilities: [], contractLevel: "control", lifecycle: "persistent", controlCapabilities: { send: true, interrupt: true, resume: true, cancel: true, fork: true, structuredOutput: true }, registeredAt: now, updatedAt: now };
    projection.workers["worker:2"] = { ...projection.workers["worker:1"]!, id: "worker:2" };
    expect(resolveControlResource(projection, { kind: "worker", query: "worker:1" })).toMatchObject({ kind: "resolved", resource: { id: "worker:1" } });
    expect(resolveControlResource(projection, { kind: "worker", query: "Reviewer" })).toMatchObject({ kind: "ambiguous", candidates: [{ id: "worker:1" }, { id: "worker:2" }] });
  });

  it("classifies runtime commands separately from durable changes", () => {
    expect(classifyCommandRisk(command())).toBe("green");
    expect(classifyChangeSetRisk(changeSet().operations)).toBe("red");
  });

  it("orders dependencies, rejects cycles, and summarizes impact", () => {
    const operations = [
      { id: "publish", kind: "publish-flow" as const, targetId: "flow:1", dependsOn: ["create"], payload: {} },
      { id: "create", kind: "create-flow" as const, dependsOn: [], payload: { id: "flow:1", name: "Daily review" } },
    ];
    expect(orderChangeOperations(operations).map((item) => item.id)).toEqual(["create", "publish"]);
    expect(analyzeChangeSet(operations).resourcesCreated[0]).toMatchObject({ kind: "flow", id: "flow:1" });
    expect(() => orderChangeOperations([{ ...operations[0]!, dependsOn: ["create"] }, { ...operations[1]!, dependsOn: ["publish"] }])).toThrow(/cycle/i);
  });

  it("executes green commands idempotently and gates red ChangeSets", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    let commandCalls = 0;
    let changeCalls = 0;
    const plane = new ControlPlane(store, {
      executeCommand: async () => ({ call: ++commandCalls }),
      applyChange: async () => ({ call: ++changeCalls }),
    });
    const first = await plane.executeCommand(command());
    const replay = await plane.executeCommand(command());
    expect(first.status).toBe("succeeded");
    expect(replay).toEqual(first);
    expect(commandCalls).toBe(1);

    const proposed = await plane.proposeChangeSet(changeSet());
    expect(proposed.status).toBe("awaiting-approval");
    await expect(plane.applyChangeSet(proposed.id)).rejects.toThrow(/approval/i);
    const approved = plane.approveChangeSet(proposed.id, "human:owner");
    expect((await plane.applyChangeSet(approved.id)).status).toBe("applied");
    expect(changeCalls).toBe(1);
  });

  it("rejects an invalid operation before persisting a ChangeSet proposal", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const plane = new ControlPlane(store, {
      executeCommand: async () => ({}),
      applyChange: async () => ({}),
      validateChange: async (operation) => {
        if (operation.kind === "create-flow") throw new Error("create-flow name is required");
      },
    });

    await expect(plane.proposeChangeSet(changeSet({
      id: "changeset:invalid",
      idempotencyKey: "changeset:invalid",
      operations: [{ id: "create", kind: "create-flow", dependsOn: [], payload: { description: "missing name" } }],
    }))).rejects.toThrow(/validation failed/i);
    expect(store.readAll()).toEqual([]);
  });

  it("uses an injected clock for command state and ledger events", async () => {
    const fixedTime = "2027-04-20T14:30:00.000Z";
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const plane = new ControlPlane(store, {
      executeCommand: async () => ({ ok: true }),
      applyChange: async () => ({ ok: true }),
    }, { now: () => new Date(fixedTime) });

    const result = await plane.executeCommand(command());

    expect(result.updatedAt).toBe(fixedTime);
    expect(new Set(store.readAll().map((event) => event.occurredAt))).toEqual(new Set([fixedTime]));
    store.close();
  });

  it("keeps partial ChangeSet results and skips dependent operations after failure", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const plane = new ControlPlane(store, {
      executeCommand: async () => ({}),
      applyChange: async (operation) => {
        if (operation.id === "first") throw new Error("provider rejected update");
        return { ok: true };
      },
    });
    const proposed = await plane.proposeChangeSet(changeSet({
      id: "changeset:partial", idempotencyKey: "changeset:partial", aggregateRisk: "yellow",
      operations: [
        { id: "first", kind: "update-worker", targetId: "worker:1", dependsOn: [], payload: {} },
        { id: "dependent", kind: "update-flow", targetId: "flow:1", dependsOn: ["first"], payload: {} },
        { id: "independent", kind: "create-task", dependsOn: [], payload: { title: "Follow up" } },
      ],
    }));
    const result = await plane.applyChangeSet(proposed.id);
    expect(result.status).toBe("partially-applied");
    expect(result.operationResults).toEqual([
      expect.objectContaining({ operationId: "first", status: "failed" }),
      expect.objectContaining({ operationId: "dependent", status: "skipped" }),
      expect.objectContaining({ operationId: "independent", status: "applied" }),
    ]);
  });

  it("passes prior operation results to dependent changes for resource references", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const observed: Array<Readonly<Record<string, unknown>>> = [];
    const plane = new ControlPlane(store, {
      executeCommand: async () => ({}),
      applyChange: async (operation, _changeSet, appliedResults) => {
        observed.push({ ...appliedResults });
        return operation.id === "create" ? { id: "worker:native:reviewer" } : { ok: true };
      },
    });
    const proposed = await plane.proposeChangeSet(changeSet({
      id: "changeset:refs", idempotencyKey: "changeset:refs", aggregateRisk: "yellow",
      operations: [
        { id: "create", kind: "create-worker", dependsOn: [], payload: { name: "Reviewer" } },
        { id: "configure", kind: "publish-worker-spec", dependsOn: ["create"], payload: { workerRef: "create" } },
      ],
    }));
    plane.approveChangeSet(proposed.id, "human:owner");
    expect((await plane.applyChangeSet(proposed.id)).status).toBe("applied");
    expect(observed[1]).toEqual({ create: { id: "worker:native:reviewer" } });
  });

  it("marks a ChangeSet failed when no operation could be applied", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const plane = new ControlPlane(store, { executeCommand: async () => ({}), applyChange: async () => { throw new Error("invalid payload"); } });
    const proposed = await plane.proposeChangeSet(changeSet({ id: "changeset:failed", idempotencyKey: "changeset:failed", aggregateRisk: "yellow" }));
    plane.approveChangeSet(proposed.id, "human:owner");
    expect((await plane.applyChangeSet(proposed.id)).status).toBe("failed");
  });

  it("validates host-owned workspace preconditions through the runtime resolver", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const plane = new ControlPlane(store, {
      executeCommand: async () => ({}),
      applyChange: async () => ({}),
      resolveResource: async (resource) => resource.kind === "workspace" && resource.id === "repository"
        ? { kind: "workspace", id: "repository", label: "demo-repo" }
        : undefined,
    });
    const proposed = await plane.proposeChangeSet(changeSet({
      id: "changeset:workspace", idempotencyKey: "changeset:workspace",
      preconditions: [{ resource: { kind: "workspace", id: "repository", label: "Current workspace" } }],
    }));
    expect(proposed.status).toBe("awaiting-approval");
  });

  it("accepts an alias only for the singleton production graph precondition", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const plane = new ControlPlane(store, { executeCommand: async () => ({}), applyChange: async () => ({}) });
    const proposed = await plane.proposeChangeSet(changeSet({
      id: "changeset:graph-alias", idempotencyKey: "changeset:graph-alias",
      preconditions: [{ resource: { kind: "graph", id: "graph:current", label: "Current graph" }, expectedVersion: 1 }],
    }));
    expect(proposed.status).toBe("awaiting-approval");
  });
});
