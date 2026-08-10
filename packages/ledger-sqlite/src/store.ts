import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEvent, type CoreEventType, type EventEnvelope } from "@mycel/domain";

export interface AppendRequest<TPayload = unknown> {
  eventType: CoreEventType;
  aggregateType: EventEnvelope["aggregateType"];
  aggregateId: string;
  actorId: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string;
  payload: TPayload;
  eventId?: string;
  occurredAt?: string;
}

export interface AppendResult<TProjection, TPayload = unknown> {
  event: EventEnvelope<TPayload>;
  inserted: boolean;
  projection: TProjection;
}

export type ProjectionReducer<TProjection> = (
  projection: Readonly<TProjection>,
  event: EventEnvelope,
) => TProjection;

interface EventRow {
  event_id: string;
  event_type: CoreEventType;
  aggregate_type: EventEnvelope["aggregateType"];
  aggregate_id: string;
  aggregate_version: number;
  actor_id: string;
  correlation_id: string;
  causation_id: string | null;
  occurred_at: string;
  idempotency_key: string;
  payload_json: string;
}

interface ProjectionRow {
  state_json: string;
}

export class SqliteEventStore<TProjection> {
  readonly #database: DatabaseSync;
  readonly #reducer: ProjectionReducer<TProjection>;
  readonly #initialProjection: TProjection;

  constructor(databasePath: string, initialProjection: TProjection, reducer: ProjectionReducer<TProjection>) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new DatabaseSync(databasePath);
    this.#reducer = reducer;
    this.#initialProjection = structuredClone(initialProjection);
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL,
        actor_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        occurred_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        UNIQUE (aggregate_type, aggregate_id, aggregate_version)
      );
      CREATE INDEX IF NOT EXISTS events_correlation_idx ON events(correlation_id, sequence);
      CREATE INDEX IF NOT EXISTS events_aggregate_idx ON events(aggregate_type, aggregate_id, aggregate_version);
      CREATE TABLE IF NOT EXISTS projection_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const row = this.#database.prepare("SELECT id FROM projection_state WHERE id = 1").get();
    if (!row) {
      this.#database
        .prepare("INSERT INTO projection_state (id, state_json, updated_at) VALUES (1, ?, ?)")
        .run(JSON.stringify(this.#initialProjection), new Date().toISOString());
    }
  }

  append<TPayload>(request: AppendRequest<TPayload>): AppendResult<TProjection, TPayload> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.#findByIdempotencyKey(request.idempotencyKey);
      if (duplicate) {
        const projection = this.getProjection();
        this.#database.exec("COMMIT");
        return { event: duplicate as EventEnvelope<TPayload>, inserted: false, projection };
      }

      const versionRow = this.#database
        .prepare(
          `SELECT COALESCE(MAX(aggregate_version), 0) AS version
           FROM events WHERE aggregate_type = ? AND aggregate_id = ?`,
        )
        .get(request.aggregateType, request.aggregateId) as { version: number };
      const event = createEvent({
        ...request,
        aggregateVersion: versionRow.version + 1,
      });
      this.#database
        .prepare(
          `INSERT INTO events (
             event_id, event_type, aggregate_type, aggregate_id, aggregate_version,
             actor_id, correlation_id, causation_id, occurred_at, idempotency_key, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.eventId,
          event.eventType,
          event.aggregateType,
          event.aggregateId,
          event.aggregateVersion,
          event.actorId,
          event.correlationId,
          event.causationId,
          event.occurredAt,
          event.idempotencyKey,
          JSON.stringify(event.payload),
        );

      const projection = this.#reducer(this.getProjection(), event as EventEnvelope);
      this.#database
        .prepare("UPDATE projection_state SET state_json = ?, updated_at = ? WHERE id = 1")
        .run(JSON.stringify(projection), new Date().toISOString());
      this.#database.exec("COMMIT");
      return { event, inserted: true, projection };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getProjection(): TProjection {
    const row = this.#database.prepare("SELECT state_json FROM projection_state WHERE id = 1").get() as unknown as
      | ProjectionRow
      | undefined;
    if (!row) throw new Error("projection_state row is missing");
    return JSON.parse(row.state_json) as TProjection;
  }

  readAll(): EventEnvelope[] {
    const rows = this.#database.prepare("SELECT * FROM events ORDER BY sequence").all() as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  readCorrelation(correlationId: string): EventEnvelope[] {
    const rows = this.#database
      .prepare("SELECT * FROM events WHERE correlation_id = ? ORDER BY sequence")
      .all(correlationId) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  rebuildProjection(): TProjection {
    const projection = this.readAll().reduce<TProjection>(
      (current, event) => this.#reducer(current, event),
      structuredClone(this.#initialProjection),
    );
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare("UPDATE projection_state SET state_json = ?, updated_at = ? WHERE id = 1")
        .run(JSON.stringify(projection), new Date().toISOString());
      this.#database.exec("COMMIT");
      return projection;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  #findByIdempotencyKey(idempotencyKey: string): EventEnvelope | undefined {
    const row = this.#database
      .prepare("SELECT * FROM events WHERE idempotency_key = ?")
      .get(idempotencyKey) as EventRow | undefined;
    return row ? rowToEvent(row) : undefined;
  }
}

function rowToEvent(row: EventRow): EventEnvelope {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    occurredAt: row.occurred_at,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json) as unknown,
  };
}
