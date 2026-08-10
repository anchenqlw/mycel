import type { ChangeSet, ControlCommand, DesignSession, EventEnvelope, ExecutionContract, Evidence, GraphNode, GraphState, HarnessIntent, ProductionProposal, StewardResult } from "@mycel/domain";
import type { AppProjection, MutationView, RunView } from "./projection.js";

export type WorkNode = Extract<GraphNode, { type: "work" }>;

export interface ClockPort {
  now(): Date;
}

export const systemClock: ClockPort = {
  now: () => new Date(),
};

export interface EventAppendRequest<TPayload = unknown> {
  eventType: EventEnvelope["eventType"];
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

export interface EventStorePort {
  append<TPayload>(request: EventAppendRequest<TPayload>): {
    event: EventEnvelope<TPayload>;
    inserted: boolean;
    projection: AppProjection;
  };
  getProjection(): AppProjection;
  readAll(): EventEnvelope[];
  readCorrelation(correlationId: string): EventEnvelope[];
  rebuildProjection(): AppProjection;
}

export interface StewardPlanInput {
  text: string;
  sourceMessageId: string;
  originatorActorId: string;
  graph: GraphState;
  repositoryId: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  localTimezone: string;
  executorActorId: string;
  testCommandId: string;
  history: Array<{ role: "user" | "steward"; text: string }>;
  designSession?: DesignSession;
  resources?: {
    actors: Array<{ id: string; name: string; kind: string }>;
    flows: Array<{ id: string; name: string; status: string }>;
    runs: Array<{ id: string; flowId: string; phase: string }>;
    workspaces: Array<{ id: string; name: string }>;
    workers?: Array<{ id: string; name: string; source: string; status: string; defaultSpecVersionId?: string }>;
    tasks?: Array<{ id: string; title: string; status: string; version: number; currentAttemptId?: string }>;
    sessions?: Array<{ id: string; workerId: string; phase: string; taskId?: string }>;
    workerSpecs?: Array<{ id: string; workerId: string; version: number }>;
  };
}

export interface StewardControlPlanePort {
  executeCommand(command: ControlCommand): Promise<ControlCommand>;
  proposeChangeSet(changeSet: ChangeSet): Promise<ChangeSet>;
}

export interface StewardPort {
  respond(input: StewardPlanInput, onProgress?: (phase: "inspecting-resources") => void | Promise<void>): Promise<HarnessIntent | StewardResult>;
  repair?(input: StewardPlanInput, diagnostics: Array<{ code: string; path: string; message: string }>, previous: HarnessIntent, onProgress?: (phase: "inspecting-resources") => void | Promise<void>): Promise<HarnessIntent>;
}

export interface ExecutorPrepareInput {
  runId: string;
  work: WorkNode;
  executorActorId: string;
  ownerActorId: string;
  acceptorActorId: string;
  repositoryId: string;
  testCommandArgv: string[];
}

export interface ExecutorProgress {
  stage: string;
  message: string;
  rawType?: string;
  occurredAt?: string;
}

export interface ExecutorResult {
  success: boolean;
  exitCode: number | null;
  summary: string;
  sessionId?: string;
  durationMs: number;
  costUsd?: number;
  evidence: Evidence[];
  error?: string;
}

export interface ExecutorPort {
  prepare(input: ExecutorPrepareInput): Promise<ExecutionContract>;
  execute(contract: ExecutionContract, onProgress: (progress: ExecutorProgress) => Promise<void>): Promise<ExecutorResult>;
  cancel(runId: string): Promise<boolean>;
}

export interface NotifierPort {
  mutationChanged(mutation: MutationView, projection: AppProjection): Promise<void>;
  runChanged(run: RunView, projection: AppProjection): Promise<void>;
  proposalChanged(proposal: ProductionProposal, projection: AppProjection): Promise<void>;
}

export class NoopNotifier implements NotifierPort {
  async mutationChanged(): Promise<void> {}
  async runChanged(): Promise<void> {}
  async proposalChanged(): Promise<void> {}
}

export class DelegatingNotifier implements NotifierPort {
  #delegate: NotifierPort = new NoopNotifier();

  setDelegate(delegate: NotifierPort): void {
    this.#delegate = delegate;
  }

  async mutationChanged(mutation: MutationView, projection: AppProjection): Promise<void> {
    await this.#delegate.mutationChanged(mutation, projection);
  }

  async runChanged(run: RunView, projection: AppProjection): Promise<void> {
    await this.#delegate.runChanged(run, projection);
  }
  async proposalChanged(proposal: ProductionProposal, projection: AppProjection): Promise<void> {
    await this.#delegate.proposalChanged(proposal, projection);
  }
}
