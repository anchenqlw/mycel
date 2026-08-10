import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@mycel/domain";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "./store.js";

interface TestProjection {
  eventIds: string[];
  count: number;
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function reducer(state: Readonly<TestProjection>, event: EventEnvelope): TestProjection {
  return { eventIds: [...state.eventIds, event.eventId], count: state.count + 1 };
}

function request(idempotencyKey: string) {
  return {
    eventType: "GraphMutation" as const,
    aggregateType: "mutation" as const,
    aggregateId: "mutation-1",
    actorId: "human-1",
    correlationId: "correlation-1",
    causationId: null,
    idempotencyKey,
    payload: { phase: "proposed" },
  };
}

describe("SqliteEventStore", () => {
  it("appends once for an idempotency key and updates the projection transactionally", () => {
    const store = new SqliteEventStore(":memory:", { eventIds: [], count: 0 }, reducer);
    const first = store.append(request("message-1"));
    const duplicate = store.append(request("message-1"));

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.event.eventId).toBe(first.event.eventId);
    expect(store.readAll()).toHaveLength(1);
    expect(store.getProjection()).toEqual({ eventIds: [first.event.eventId], count: 1 });
    store.close();
  });

  it("persists and rebuilds projection state after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "mycel-ledger-"));
    directories.push(directory);
    const databasePath = join(directory, "ledger.db");
    const firstStore = new SqliteEventStore(databasePath, { eventIds: [], count: 0 }, reducer);
    firstStore.append(request("message-1"));
    firstStore.append({ ...request("message-2"), payload: { phase: "applied" } });
    firstStore.close();

    const reopened = new SqliteEventStore(databasePath, { eventIds: [], count: 0 }, reducer);
    expect(reopened.getProjection().count).toBe(2);
    expect(reopened.rebuildProjection()).toEqual(reopened.getProjection());
    expect(reopened.readCorrelation("correlation-1")).toHaveLength(2);
    reopened.close();
  });
});
