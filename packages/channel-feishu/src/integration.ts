import type {
  AppProjection,
  ApplicationService,
  MutationView,
  NotifierPort,
  RunView,
} from "@mycel/application";
import type { ProductionProposal } from "@mycel/domain";
import * as Lark from "@larksuiteoapi/node-sdk";

export interface FeishuIntegrationConfig {
  appId: string;
  appSecret: string;
  allowedOpenIds: string[];
  ownerActorId: string;
  pairFirstPrivateUser?: boolean;
  onOwnerPaired?: (input: { openId: string }) => void | Promise<void>;
  source?: string;
  debug?: boolean;
  approveProposal?: (proposalId: string) => Promise<unknown>;
  rejectProposal?: (proposalId: string, reason?: string) => unknown;
}

export interface FeishuMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  content: string;
  rawContentType: string;
  mentionedBot: boolean;
}

export interface FeishuChannelPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(name: "message", handler: (message: FeishuMessage) => void | Promise<void>): () => void;
  on(name: "error" | "reconnecting" | "reconnected", handler: (...args: unknown[]) => void): () => void;
  send(to: string, input: { markdown: string } | { text: string }, options?: { replyTo?: string }): Promise<{ messageId: string }>;
}

export interface FeishuLogger {
  info(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

const consoleLogger: FeishuLogger = {
  info: (message, details) => console.info(message, details ?? ""),
  error: (message, details) => console.error(message, details ?? ""),
};

export class FeishuIntegration implements NotifierPort {
  readonly #application: ApplicationService;
  readonly #config: FeishuIntegrationConfig;
  readonly #channel: FeishuChannelPort;
  readonly #allowed: Set<string>;
  readonly #logger: FeishuLogger;
  #unsubscribers: Array<() => void> = [];
  #started = false;

  constructor(
    application: ApplicationService,
    config: FeishuIntegrationConfig,
    channel: FeishuChannelPort = createOfficialChannel(config),
    logger: FeishuLogger = consoleLogger,
  ) {
    this.#application = application;
    this.#config = config;
    this.#channel = channel;
    this.#allowed = new Set(config.allowedOpenIds);
    this.#logger = logger;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#unsubscribers = [
      this.#channel.on("message", (message) => this.#handleMessage(message)),
      this.#channel.on("error", (error) => this.#logger.error("Feishu channel error", errorMessage(error))),
      this.#channel.on("reconnecting", () => this.#logger.info("Feishu channel reconnecting")),
      this.#channel.on("reconnected", () => this.#logger.info("Feishu channel reconnected")),
    ];
    try {
      await this.#channel.connect();
      this.#started = true;
      this.#logger.info("Feishu channel connected");
    } catch (error) {
      this.#clearSubscriptions();
      throw error;
    }
  }

  stop(): void {
    this.#started = false;
    this.#clearSubscriptions();
    void this.#channel.disconnect().catch((error: unknown) => this.#logger.error("Feishu channel disconnect failed", errorMessage(error)));
  }

  async mutationChanged(mutation: MutationView, projection: AppProjection): Promise<void> {
    const message = sourceMessageForMutation(mutation, projection);
    if (!message || message.channel !== "feishu") return;
    const status = mutation.pendingOperationIds.length ? "等待你批准" : mutation.status;
    await this.#safeSend(message.conversationId, `**${mutation.diff.workTitle}**\n\n${mutation.diff.intentSummary}\n\n状态：${status}\n\n可回复：\`批准 ${mutation.id}\` 或 \`拒绝 ${mutation.id}\``);
  }

  async runChanged(run: RunView, projection: AppProjection): Promise<void> {
    if (!["succeeded", "failed", "canceled"].includes(run.phase)) return;
    const mutation = projection.mutations[run.mutationId];
    if (!mutation) return;
    const message = sourceMessageForMutation(mutation, projection);
    if (!message || message.channel !== "feishu") return;
    await this.#safeSend(message.conversationId, `**运行 ${run.phase}**\n\n${run.message}\n\nRun：\`${run.id}\``);
  }

  async proposalChanged(_proposal: ProductionProposal, _projection: AppProjection): Promise<void> {
    // The inbound request handler sends the proposal once after submitIntent resolves.
  }

  async #handleMessage(message: FeishuMessage): Promise<void> {
    if (message.rawContentType !== "text") return;
    if (message.chatType === "group" && !message.mentionedBot) return;
    if (this.#allowed.size === 0 && this.#config.pairFirstPrivateUser && message.chatType === "p2p") {
      this.#allowed.add(message.senderId);
      await this.#config.onOwnerPaired?.({ openId: message.senderId });
    }
    if (!this.#allowed.has(message.senderId)) {
      this.#logger.info("Ignoring Feishu message from a non-owner", maskIdentity(message.senderId));
      return;
    }
    const text = message.content.trim();
    if (!text) return;
    if (await this.#handleTextAction(text, message.messageId)) return;
    const result = await this.#application.submitIntent({
      messageId: message.messageId,
      channel: "feishu",
      conversationId: message.chatId,
      actorId: this.#config.ownerActorId,
      text,
    });
    if (result.replayed || result.kind === "weave_diff") return;
    const response = result.kind === "answer" || result.kind === "clarification"
      ? result.response.text
      : result.kind === "proposal"
        ? `${result.block.text}\n\n**方案：${result.proposal.plan.title}**\n状态：等待批准。可在 Mycel 工作台处理。`
        : result.block.text;
    await this.#safeSend(message.chatId, response, message.messageId);
  }

  async #handleTextAction(text: string, messageId: string): Promise<boolean> {
    const parsed = /^(批准|approve|拒绝|reject|取消|cancel|验收|accept|退回)\s+(\S+)(?:\s+(.+))?$/i.exec(text);
    if (!parsed) return false;
    const verb = parsed[1]?.toLowerCase();
    const aggregateId = parsed[2];
    if (!verb || !aggregateId) return false;
    const reason = parsed[3] ?? "Requested from Feishu text command";
    const key = `feishu:text-action:${messageId}`;
    if (verb === "批准" || verb === "approve") {
      if (aggregateId.startsWith("proposal:")) {
        if (!this.#config.approveProposal) throw new Error("proposal deployment is unavailable");
        await this.#config.approveProposal(aggregateId);
      } else await this.#application.approveMutation(aggregateId, this.#config.ownerActorId, key);
    } else if (verb === "拒绝" || verb === "reject") {
      if (aggregateId.startsWith("proposal:")) {
        if (!this.#config.rejectProposal) throw new Error("proposal rejection is unavailable");
        await this.#config.rejectProposal(aggregateId, reason);
      } else await this.#application.rejectMutation(aggregateId, this.#config.ownerActorId, key, reason);
    } else if (verb === "取消" || verb === "cancel") await this.#application.cancelRun(aggregateId, this.#config.ownerActorId, key);
    else if (verb === "验收" || verb === "accept") await this.#application.acceptWork(aggregateId, this.#config.ownerActorId, key);
    else await this.#application.rejectWork(aggregateId, this.#config.ownerActorId, key, reason);
    return true;
  }

  async #safeSend(chatId: string, markdown: string, replyTo?: string): Promise<void> {
    try {
      if (replyTo) await this.#channel.send(chatId, { markdown }, { replyTo });
      else await this.#channel.send(chatId, { markdown });
    } catch (error) {
      this.#logger.error("Feishu reply failed", errorMessage(error));
    }
  }

  #clearSubscriptions(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
  }
}

function createOfficialChannel(config: FeishuIntegrationConfig): FeishuChannelPort {
  return Lark.createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: "websocket",
    source: config.source ?? "mycel",
    loggerLevel: config.debug ? Lark.LoggerLevel.debug : Lark.LoggerLevel.info,
    policy: { dmMode: "open", requireMention: true, respondToMentionAll: false },
    safety: { chatQueue: { enabled: true }, staleMessageWindowMs: 5 * 60_000 },
    outbound: { markdownConverter: "builtin", retry: { maxAttempts: 2, baseDelayMs: 300 } },
    handshakeTimeoutMs: 15_000,
  }) as unknown as FeishuChannelPort;
}

function sourceMessageForMutation(mutation: MutationView, projection: AppProjection) {
  return projection.messages.find((item) => item.id === mutation.diff.sourceMessageId);
}

function maskIdentity(value: string): string {
  return value.length <= 8 ? `${value.slice(0, 2)}***` : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface FeishuRegistrationOptions {
  signal: AbortSignal;
  onQrCode(info: { url: string; expireIn: number }): void;
  onStatus?(info: { status: "polling" | "slow_down" | "domain_switched"; interval?: number }): void;
}

export async function registerFeishuApp(options: FeishuRegistrationOptions): Promise<{
  appId: string;
  appSecret: string;
}> {
  const result = await Lark.registerApp({
    signal: options.signal,
    source: "mycel",
    createOnly: true,
    appPreset: { name: "Mycel Steward", desc: "通过 Mycel 协调人与 Agent 的本地生产关系" },
    addons: {
      preset: true,
      scopes: { tenant: ["im:message", "im:message:send_as_bot"] },
      events: { items: { tenant: ["im.message.receive_v1"] } },
    },
    onQRCodeReady: options.onQrCode,
    ...(options.onStatus ? { onStatusChange: options.onStatus } : {}),
  });
  return { appId: result.client_id, appSecret: result.client_secret };
}
