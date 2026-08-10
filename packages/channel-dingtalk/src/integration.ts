import {
  type AppProjection,
  ApplicationService,
  type MutationView,
  type NotifierPort,
  type RunView,
} from "@mycel/application";
import type { ProductionProposal } from "@mycel/domain";
import {
  DWClient,
  EventAck,
  TOPIC_CARD,
  TOPIC_ROBOT,
  type DWClientDownStream,
  type RobotTextMessage,
} from "dingtalk-stream";
import { parseCardAction } from "./callback.js";
import { mutationCardModel, proposalCardModel, runCardModel, type CardModel } from "./card-model.js";
import { DingTalkOpenApiCardTransport, type CardTransport, type DingTalkCardTransportConfig } from "./card-transport.js";
import { DingTalkSessionWebhookTextTransport, type TextReplyTransport } from "./text-transport.js";

export interface DingTalkIntegrationConfig {
  clientId: string;
  clientSecret: string;
  cardTemplateId?: string;
  robotCode?: string;
  allowedUserIds: string[];
  ownerActorId: string;
  pairFirstPrivateUser?: boolean;
  onOwnerPaired?: (input: { userId: string; robotCode: string }) => void | Promise<void>;
  debug?: boolean;
  approveProposal?: (proposalId: string) => Promise<unknown>;
  rejectProposal?: (proposalId: string, reason?: string) => unknown;
}

export interface DingTalkLogger {
  info(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

const consoleLogger: DingTalkLogger = {
  info: (message, details) => console.info(message, details ?? ""),
  error: (message, details) => console.error(message, details ?? ""),
};

export class DingTalkIntegration implements NotifierPort {
  readonly #application: ApplicationService;
  readonly #config: DingTalkIntegrationConfig;
  readonly #transport: CardTransport | undefined;
  readonly #allowed: Set<string>;
  readonly #logger: DingTalkLogger;
  readonly #textTransport: TextReplyTransport;
  #client: DWClient | undefined;

  constructor(
    application: ApplicationService,
    config: DingTalkIntegrationConfig,
    transport?: CardTransport,
    logger: DingTalkLogger = consoleLogger,
    textTransport: TextReplyTransport = new DingTalkSessionWebhookTextTransport(),
  ) {
    this.#application = application;
    this.#config = config;
    this.#transport = transport ?? createCardTransport(config);
    this.#allowed = new Set(config.allowedUserIds);
    this.#logger = logger;
    this.#textTransport = textTransport;
  }

  async start(): Promise<void> {
    if (this.#client) return;
    const client = new DWClient({
      clientId: this.#config.clientId,
      clientSecret: this.#config.clientSecret,
      debug: this.#config.debug ?? false,
      keepAlive: true,
    });
    client.registerAllEventListener((message) => {
      void this.#handleStreamMessage(message).catch((error: unknown) => {
        this.#logger.error("DingTalk message handling failed", errorMessage(error));
      });
      return { status: EventAck.SUCCESS };
    });
    this.#client = client;
    try {
      await client.connect();
      this.#logger.info("DingTalk Stream connected");
    } catch (error) {
      this.#client = undefined;
      throw error;
    }
  }

  stop(): void {
    this.#client?.disconnect();
    this.#client = undefined;
  }

  async mutationChanged(mutation: MutationView, projection: AppProjection): Promise<void> {
    if (!this.#transport) return;
    if (sourceMessageForMutation(mutation, projection)?.channel !== "dingtalk") return;
    try {
      await this.#upsertWorkflowCard(mutation, mutationCardModel(mutation), projection);
    } catch (error) {
      this.#logger.error("DingTalk mutation card update failed", errorMessage(error));
    }
  }

  async runChanged(run: RunView, projection: AppProjection): Promise<void> {
    if (!this.#transport) return;
    try {
      const mutation = projection.mutations[run.mutationId];
      if (!mutation) throw new Error(`mutation not found for run: ${run.id}`);
      if (sourceMessageForMutation(mutation, projection)?.channel !== "dingtalk") return;
      await this.#upsertWorkflowCard(mutation, runCardModel(run, projection), projection);
    } catch (error) {
      this.#logger.error("DingTalk run card update failed", errorMessage(error));
    }
  }

  async proposalChanged(proposal: ProductionProposal, projection: AppProjection): Promise<void> {
    if (!this.#transport) return;
    try {
      const model = proposalCardModel(proposal);
      const existing = projection.cards[proposal.id];
      if (existing) await this.#transport.update(proposal.id, model.params);
      else {
        const message = projection.messages.find((item) => item.id === proposal.sourceMessageId);
        if (!message || message.channel !== "dingtalk") return;
        const delivered = await this.#transport.deliver({ outTrackId: proposal.id, recipientUserId: message.conversationId, params: model.params });
        this.#application.recordCardDelivered({ outTrackId: proposal.id, aggregateId: proposal.id, state: model.state, correlationId: `proposal:${proposal.id}`, ...(delivered.cardInstanceId ? { cardInstanceId: delivered.cardInstanceId } : {}) });
        return;
      }
      this.#application.recordCardDelivered({ outTrackId: proposal.id, aggregateId: proposal.id, state: model.state, correlationId: `proposal:${proposal.id}`, ...(existing.cardInstanceId ? { cardInstanceId: existing.cardInstanceId } : {}) });
    } catch (error) { this.#logger.error("DingTalk proposal card update failed", errorMessage(error)); }
  }

  async #handleStreamMessage(message: DWClientDownStream): Promise<void> {
    const raw: unknown = JSON.parse(message.data);
    if (message.headers.topic === TOPIC_ROBOT) {
      await this.#handleRobotMessage(raw as RobotTextMessage);
      return;
    }
    if (message.headers.topic === TOPIC_CARD) {
      await this.#handleCardCallback(message.headers.messageId, raw);
      return;
    }
    this.#logger.info("Ignoring unsupported DingTalk topic", message.headers.topic);
  }

  async #handleRobotMessage(message: RobotTextMessage): Promise<void> {
    if (message.msgtype !== "text") return;
    if (this.#allowed.size === 0 && this.#config.pairFirstPrivateUser && isPrivateConversation(message.conversationType)) {
      this.#allowed.add(message.senderStaffId);
      await this.#config.onOwnerPaired?.({ userId: message.senderStaffId, robotCode: message.robotCode });
    }
    if (!this.#allowed.has(message.senderStaffId)) {
      this.#logger.info("Ignoring DingTalk message from a non-allowlisted user", message.senderStaffId);
      return;
    }
    const text = message.text.content.trim();
    if (await this.#handleTextAction(text, message.msgId)) return;
    const result = await this.#application.submitIntent({
      messageId: message.msgId,
      channel: "dingtalk",
      conversationId: message.senderStaffId,
      actorId: this.#config.ownerActorId,
      text,
    });
    if (!result.replayed && result.kind !== "weave_diff") {
      const text = result.kind === "answer" || result.kind === "clarification"
        ? result.response.text
        : result.kind === "proposal"
          ? `${result.block.text}\n\n方案：${result.proposal.plan.title}\n状态：等待批准（请在 Mycel 工作台确认部署）`
          : result.block.text;
      await this.#textTransport.reply(message.sessionWebhook, text);
    }
  }

  async #handleCardCallback(messageId: string, raw: unknown): Promise<void> {
    const action = parseCardAction(raw);
    if (!this.#allowed.has(action.actorUserId)) {
      this.#logger.info("Ignoring DingTalk card callback from a non-allowlisted user", action.actorUserId);
      return;
    }
    const recorded = this.#application.recordCardCallback({
      messageId,
      outTrackId: action.outTrackId,
      action: action.action,
      actorId: this.#config.ownerActorId,
      raw,
    });
    if (!recorded.inserted) return;
    const idempotencyKey = `dingtalk:action:${messageId}`;
    switch (action.action) {
      case "approve":
        await this.#application.approveMutation(action.aggregateId, this.#config.ownerActorId, idempotencyKey);
        break;
      case "reject":
        await this.#application.rejectMutation(action.aggregateId, this.#config.ownerActorId, idempotencyKey, action.reason ?? "Rejected from DingTalk");
        break;
      case "revise":
        await this.#application.rejectMutation(action.aggregateId, this.#config.ownerActorId, idempotencyKey, action.reason ?? "Revision requested from DingTalk", true);
        break;
      case "cancel":
        await this.#application.cancelRun(action.aggregateId, this.#config.ownerActorId, idempotencyKey);
        break;
      case "accept":
        await this.#application.acceptWork(action.aggregateId, this.#config.ownerActorId, idempotencyKey);
        break;
      case "reject_acceptance":
        await this.#application.rejectWork(action.aggregateId, this.#config.ownerActorId, idempotencyKey, action.reason ?? "Changes requested from DingTalk");
        break;
      case "approve_proposal":
        if (!this.#config.approveProposal) throw new Error("proposal deployment is unavailable");
        await this.#config.approveProposal(action.aggregateId);
        break;
      case "reject_proposal":
        if (!this.#config.rejectProposal) throw new Error("proposal rejection is unavailable");
        await this.#config.rejectProposal(action.aggregateId, action.reason);
        break;
    }
  }

  async #handleTextAction(text: string, messageId: string): Promise<boolean> {
    const parsed = /^(批准|approve|拒绝|reject|取消|cancel|验收|accept|退回)\s+(\S+)(?:\s+(.+))?$/i.exec(text);
    if (!parsed) return false;
    const verb = parsed[1]?.toLowerCase();
    const aggregateId = parsed[2];
    if (!verb || !aggregateId) return false;
    const reason = parsed[3] ?? "Requested from DingTalk text command";
    const key = `dingtalk:text-action:${messageId}`;
    if (verb === "批准" || verb === "approve") await this.#application.approveMutation(aggregateId, this.#config.ownerActorId, key);
    else if (verb === "拒绝" || verb === "reject") await this.#application.rejectMutation(aggregateId, this.#config.ownerActorId, key, reason);
    else if (verb === "取消" || verb === "cancel") await this.#application.cancelRun(aggregateId, this.#config.ownerActorId, key);
    else if (verb === "验收" || verb === "accept") await this.#application.acceptWork(aggregateId, this.#config.ownerActorId, key);
    else await this.#application.rejectWork(aggregateId, this.#config.ownerActorId, key, reason);
    return true;
  }

  async #upsertWorkflowCard(mutation: MutationView, model: CardModel, projection: AppProjection): Promise<void> {
    const transport = this.#transport;
    if (!transport) return;
    const outTrackId = mutation.id;
    const existing = projection.cards[outTrackId];
    if (existing) {
      await transport.update(outTrackId, model.params);
    } else {
      const recipientUserId = recipientForMutation(mutation, projection);
      const delivered = await transport.deliver({ outTrackId, recipientUserId, params: model.params });
      this.#application.recordCardDelivered({
        outTrackId,
        aggregateId: mutation.id,
        state: model.state,
        correlationId: mutation.correlationId,
        ...(delivered.cardInstanceId !== undefined ? { cardInstanceId: delivered.cardInstanceId } : {}),
      });
      return;
    }
    this.#application.recordCardDelivered({
      outTrackId,
      aggregateId: mutation.id,
      state: model.state,
      correlationId: mutation.correlationId,
      ...(existing.cardInstanceId !== undefined ? { cardInstanceId: existing.cardInstanceId } : {}),
    });
  }
}

function createCardTransport(config: DingTalkIntegrationConfig): CardTransport | undefined {
  if (!config.cardTemplateId || !config.robotCode) return undefined;
  const cardConfig: DingTalkCardTransportConfig = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    cardTemplateId: config.cardTemplateId,
    robotCode: config.robotCode,
  };
  return new DingTalkOpenApiCardTransport(cardConfig);
}

function isPrivateConversation(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "single" || normalized === "private" || normalized === "singlechat";
}

function recipientForMutation(mutation: MutationView, projection: AppProjection): string {
  const message = sourceMessageForMutation(mutation, projection);
  if (!message) throw new Error(`source message not found for mutation: ${mutation.id}`);
  return message.conversationId;
}

function sourceMessageForMutation(mutation: MutationView, projection: AppProjection) {
  return projection.messages.find((item) => item.id === mutation.diff.sourceMessageId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
