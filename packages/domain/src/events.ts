import { ulid } from "ulid";

export type CoreEventType =
  | "GraphMutation"
  | "ExecutionEvent"
  | "EvidenceAttached"
  | "Judgment"
  | "ChannelMessageReceived"
  | "StewardResponseProduced"
  | "ConversationBlockEvent"
  | "DesignSessionEvent"
  | "ProductionProposalEvent"
  | "AgentRuntimeEvent"
  | "AgentSessionEvent"
  | "WorkerRuntimeEvent"
  | "WorkerSpecEvent"
  | "WorkerSessionEvent"
  | "TaskEvent"
  | "TaskAttemptEvent"
  | "ControlCommandEvent"
  | "ChangeSetEvent"
  | "FlowDefinitionEvent"
  | "FlowRuntimeEvent"
  | "CollaborationRuntimeEvent"
  | "ContentRetentionEvent"
  | "CardDelivered"
  | "CardCallbackReceived"
  | "ProjectionRebuilt";

export interface EventEnvelope<TPayload = unknown> {
  eventId: string;
  eventType: CoreEventType;
  aggregateType: "graph" | "mutation" | "work" | "run" | "channel" | "card" | "system";
  aggregateId: string;
  aggregateVersion: number;
  actorId: string;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  idempotencyKey: string;
  payload: TPayload;
}

export type NewEvent<TPayload = unknown> = Omit<EventEnvelope<TPayload>, "eventId" | "occurredAt"> & {
  eventId?: string;
  occurredAt?: string;
};

export function createEvent<TPayload>(input: NewEvent<TPayload>): EventEnvelope<TPayload> {
  return {
    ...input,
    eventId: input.eventId ?? ulid(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
}
