import type { ChangeOperation, ChangeSet, ControlCommand, ControlResourceReference } from "@mycel/domain";
import type { ClockPort, EventStorePort } from "./ports.js";
import { systemClock } from "./ports.js";
import { analyzeChangeSet, orderChangeOperations } from "./impact-analyzer.js";
import { classifyChangeSetRisk, classifyCommandRisk } from "./risk-policy.js";
import { resourcesOfKind } from "./resource-resolver.js";

export interface ControlPlaneHandlers {
  executeCommand(command: ControlCommand): Promise<unknown>;
  applyChange(operation: ChangeOperation, changeSet: ChangeSet, appliedResults: Readonly<Record<string, unknown>>): Promise<unknown>;
  validateChange?(operation: ChangeOperation, changeSet: ChangeSet): Promise<void> | void;
  resolveResource?(resource: ControlResourceReference): Promise<ControlResourceReference | undefined>;
}

export class ChangeSetValidationError extends Error {
  constructor() {
    super("ChangeSet validation failed");
    this.name = "ChangeSetValidationError";
  }
}

export class ControlPlane {
  readonly #store: EventStorePort;
  readonly #handlers: ControlPlaneHandlers;
  readonly #clock: ClockPort;

  constructor(store: EventStorePort, handlers: ControlPlaneHandlers, clock: ClockPort = systemClock) {
    this.#store = store;
    this.#handlers = handlers;
    this.#clock = clock;
  }

  async executeCommand(input: ControlCommand): Promise<ControlCommand> {
    const existing = this.#store.getProjection().commands[input.id];
    if (existing) {
      if (existing.idempotencyKey !== input.idempotencyKey) throw new Error(`Command ID conflict: ${input.id}`);
      if (existing.status === "succeeded" || existing.status === "failed") return existing;
    }
    const risk = classifyCommandRisk(input);
    if (risk === "red" && input.arguments.confirmed !== true) throw new Error(`Command ${input.action} requires explicit approval`);
    this.#assertExpectedVersion(input);
    const executing = { ...input, status: "executing" as const, updatedAt: this.#now() };
    this.#persistCommand(executing, `${input.idempotencyKey}:executing`);
    try {
      const result = await this.#handlers.executeCommand(executing);
      const succeeded: ControlCommand = { ...executing, status: "succeeded", result, updatedAt: this.#now() };
      this.#persistCommand(succeeded, `${input.idempotencyKey}:succeeded`);
      return succeeded;
    } catch (error) {
      const failed: ControlCommand = { ...executing, status: "failed", error: errorMessage(error), updatedAt: this.#now() };
      this.#persistCommand(failed, `${input.idempotencyKey}:failed`);
      return failed;
    }
  }

  async proposeChangeSet(input: ChangeSet): Promise<ChangeSet> {
    const existing = this.#store.getProjection().changeSets[input.id];
    if (existing) {
      if (existing.idempotencyKey !== input.idempotencyKey) throw new Error(`ChangeSet ID conflict: ${input.id}`);
      return existing;
    }
    try {
      orderChangeOperations(input.operations);
      for (const operation of input.operations) await this.#handlers.validateChange?.(operation, input);
      await this.#assertPreconditions(input);
    } catch {
      throw new ChangeSetValidationError();
    }
    const aggregateRisk = classifyChangeSetRisk(input.operations);
    const changeSet: ChangeSet = {
      ...input,
      aggregateRisk,
      impact: analyzeChangeSet(input.operations),
      status: aggregateRisk === "red" ? "awaiting-approval" : "validated",
      operationResults: input.operations.map((operation) => ({ operationId: operation.id, status: "pending" })),
      updatedAt: this.#now(),
    };
    this.#persistChangeSet(changeSet, `${input.idempotencyKey}:proposed`);
    return changeSet;
  }

  approveChangeSet(changeSetId: string, actorId: string): ChangeSet {
    const current = this.#requiredChangeSet(changeSetId);
    if (current.status !== "awaiting-approval") throw new Error(`ChangeSet cannot be approved from ${current.status}`);
    const approved: ChangeSet = { ...current, status: "validated", approvedBy: actorId, updatedAt: this.#now() };
    this.#persistChangeSet(approved, `${current.idempotencyKey}:approved:${actorId}`);
    return approved;
  }

  rejectChangeSet(changeSetId: string, actorId: string): ChangeSet {
    const current = this.#requiredChangeSet(changeSetId);
    if (current.status !== "awaiting-approval" && current.status !== "validated") throw new Error(`ChangeSet cannot be rejected from ${current.status}`);
    const rejected: ChangeSet = { ...current, status: "rejected", approvedBy: actorId, updatedAt: this.#now() };
    this.#persistChangeSet(rejected, `${current.idempotencyKey}:rejected:${actorId}`);
    return rejected;
  }

  async applyChangeSet(changeSetId: string): Promise<ChangeSet> {
    let current = this.#requiredChangeSet(changeSetId);
    if (current.status === "applied" || current.status === "partially-applied" || current.status === "failed") return current;
    if (current.status === "awaiting-approval") throw new Error("ChangeSet requires explicit approval before applying");
    if (current.status !== "validated") throw new Error(`ChangeSet cannot apply from ${current.status}`);
    if (current.aggregateRisk === "red" && !current.approvedBy) throw new Error("Red ChangeSet requires explicit approval");
    await this.#assertPreconditions(current);
    current = { ...current, status: "applying", updatedAt: this.#now() };
    this.#persistChangeSet(current, `${current.idempotencyKey}:applying`);

    const results = new Map(current.operationResults.map((result) => [result.operationId, result]));
    const appliedResults: Record<string, unknown> = {};
    for (const operation of orderChangeOperations(current.operations)) {
      const dependencyFailed = operation.dependsOn.some((id) => {
        const status = results.get(id)?.status;
        return status === "failed" || status === "skipped";
      });
      if (dependencyFailed) {
        results.set(operation.id, { operationId: operation.id, status: "skipped", error: "A dependency did not apply" });
        continue;
      }
      try {
        const result = await this.#handlers.applyChange(operation, current, appliedResults);
        appliedResults[operation.id] = result;
        results.set(operation.id, { operationId: operation.id, status: "applied", result });
      } catch (error) {
        results.set(operation.id, { operationId: operation.id, status: "failed", error: errorMessage(error) });
      }
    }
    const operationResults = current.operations.map((operation) => results.get(operation.id)!);
    const failed = operationResults.some((result) => result.status === "failed" || result.status === "skipped");
    const applied = operationResults.some((result) => result.status === "applied");
    const status: ChangeSet["status"] = !failed ? "applied" : applied ? "partially-applied" : "failed";
    const finished: ChangeSet = { ...current, status, operationResults, updatedAt: this.#now() };
    this.#persistChangeSet(finished, `${current.idempotencyKey}:finished`);
    return finished;
  }

  #assertExpectedVersion(command: ControlCommand): void {
    if (command.expectedVersion === undefined) return;
    const resource = resourcesOfKind(this.#store.getProjection(), command.target.kind).find((candidate) => candidate.id === command.target.id);
    if (!resource) throw new Error(`Command target not found: ${command.target.id}`);
    if (resource.version !== command.expectedVersion) throw new Error(`Command expected version ${command.expectedVersion}, found ${resource.version ?? "unversioned"}`);
  }

  async #assertPreconditions(changeSet: ChangeSet): Promise<void> {
    for (const precondition of changeSet.preconditions) {
      const candidates = resourcesOfKind(this.#store.getProjection(), precondition.resource.kind);
      const singletonGraph = precondition.resource.kind === "graph" && candidates.length === 1 ? candidates[0] : undefined;
      const resource = candidates.find((candidate) => candidate.id === precondition.resource.id)
        ?? singletonGraph
        ?? await this.#handlers.resolveResource?.(precondition.resource);
      if (!resource) throw new Error(`ChangeSet precondition resource not found: ${precondition.resource.id}`);
      if (precondition.expectedVersion !== undefined && resource.version !== precondition.expectedVersion) {
        throw new Error(`ChangeSet expected version ${precondition.expectedVersion} for ${resource.id}, found ${resource.version ?? "unversioned"}`);
      }
    }
  }

  #persistCommand(command: ControlCommand, idempotencyKey: string): void {
    this.#store.append({ eventType: "ControlCommandEvent", aggregateType: "run", aggregateId: command.id, actorId: command.initiatedBy, correlationId: `command:${command.id}`, causationId: null, idempotencyKey, occurredAt: this.#now(), payload: { command } });
  }

  #persistChangeSet(changeSet: ChangeSet, idempotencyKey: string): void {
    this.#store.append({ eventType: "ChangeSetEvent", aggregateType: "mutation", aggregateId: changeSet.id, actorId: changeSet.initiatedBy, correlationId: `changeset:${changeSet.id}`, causationId: null, idempotencyKey, occurredAt: this.#now(), payload: { changeSet } });
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #requiredChangeSet(id: string): ChangeSet {
    const changeSet = this.#store.getProjection().changeSets[id];
    if (!changeSet) throw new Error(`ChangeSet not found: ${id}`);
    return changeSet;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
