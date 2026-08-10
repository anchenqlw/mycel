import { z } from "zod";

const CallbackEnvelopeSchema = z.object({
  outTrackId: z.string().min(1),
  userId: z.string().optional(),
  operatorUserId: z.string().optional(),
  staffId: z.string().optional(),
  actionId: z.string().optional(),
  action: z.string().optional(),
  value: z.unknown().optional(),
}).passthrough();

export interface CardAction {
  outTrackId: string;
  actorUserId: string;
  action: "approve" | "reject" | "revise" | "cancel" | "accept" | "reject_acceptance" | "approve_proposal" | "reject_proposal";
  aggregateId: string;
  reason?: string;
}

export function parseCardAction(raw: unknown): CardAction {
  const envelope = CallbackEnvelopeSchema.parse(raw);
  const value = objectValue(envelope.value);
  const rawAction = firstString(value.action, value.actionId, envelope.action, envelope.actionId);
  const action = normalizeAction(rawAction);
  const actorUserId = firstString(envelope.userId, envelope.operatorUserId, envelope.staffId);
  if (!actorUserId) throw new Error("DingTalk card callback is missing userId");
  const aggregateId = firstString(value.aggregateId, value.mutationId, value.workId, value.runId, envelope.outTrackId);
  if (!aggregateId) throw new Error("DingTalk card callback is missing aggregateId");
  const reason = firstString(value.reason);
  return {
    outTrackId: envelope.outTrackId,
    actorUserId,
    action,
    aggregateId,
    ...(reason ? { reason } : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return objectValue(parsed);
    } catch {
      return { action: value };
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function normalizeAction(value: string | undefined): CardAction["action"] {
  switch (value?.toLowerCase()) {
    case "approve":
    case "批准":
      return "approve";
    case "reject":
    case "拒绝":
      return "reject";
    case "revise":
    case "修改":
      return "revise";
    case "cancel":
    case "取消":
      return "cancel";
    case "accept":
    case "验收":
      return "accept";
    case "reject_acceptance":
    case "退回":
      return "reject_acceptance";
    case "approve_proposal":
      return "approve_proposal";
    case "reject_proposal":
      return "reject_proposal";
    default:
      throw new Error(`unsupported DingTalk card action: ${value ?? "<missing>"}`);
  }
}
