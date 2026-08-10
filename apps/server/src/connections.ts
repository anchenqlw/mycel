import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import type { AppProjection, ApplicationService, DelegatingNotifier, MutationView, NotifierPort, RunView } from "@mycel/application";
import { NoopNotifier } from "@mycel/application";
import { DingTalkIntegration, type DingTalkIntegrationConfig } from "@mycel/channel-dingtalk";
import { FeishuIntegration, type FeishuIntegrationConfig, registerFeishuApp } from "@mycel/channel-feishu";
import type { AgentProfile, ProductionProposal } from "@mycel/domain";
import QRCode from "qrcode";
import { ulid } from "ulid";
import type { ControlPlaneService } from "./control-plane.js";

export type ConnectionPhase =
  | "disconnected"
  | "creating-session"
  | "waiting-for-scan"
  | "authorizing"
  | "connecting"
  | "connected"
  | "degraded"
  | "expired"
  | "cancelled"
  | "failed";

export interface DingTalkConnectionView {
  id: "connection:dingtalk";
  phase: ConnectionPhase;
  message: string;
  hasCredentials: boolean;
  pairingPending: boolean;
  cardMode: "interactive" | "markdown";
  ownerUserId?: string;
  clientIdHint?: string;
  connectedAt?: string;
  updatedAt: string;
}

export interface FeishuConnectionView {
  id: "connection:feishu";
  phase: ConnectionPhase;
  message: string;
  hasCredentials: boolean;
  pairingPending: boolean;
  messageMode: "markdown";
  ownerOpenId?: string;
  appIdHint?: string;
  qr?: { sessionId: string; imageDataUrl: string; verificationUrl: string; expiresAt: string } | undefined;
  connectedAt?: string;
  updatedAt: string;
}

export interface LocalAgentCandidate {
  id: string;
  name: string;
  adapterKind: "claude-code" | "codex";
  available: boolean;
  authState: "authenticated" | "unauthenticated" | "unknown";
  version?: string;
  executable: string;
  capabilities: string[];
  adopted: boolean;
  error?: string;
  probedAt: string;
}

export interface ExternalDiscoveryView {
  id: string;
  protocol: "mcp" | "a2a";
  endpoint: string;
  name: string;
  status: "ready" | "failed" | "adopted";
  capabilities: string[];
  contractLevel: AgentProfile["contractLevel"];
  detail: string;
  discoveredAt: string;
  adoptedAgentId?: string;
}

export interface ConnectionsSnapshot {
  im: { dingtalk: DingTalkConnectionView; feishu: FeishuConnectionView };
  localAgents: LocalAgentCandidate[];
  externalDiscoveries: ExternalDiscoveryView[];
}

interface DingTalkSecret {
  clientId: string;
  clientSecret: string;
  allowedUserIds: string[];
  robotCode?: string;
  cardTemplateId?: string;
}

interface FeishuSecret {
  appId: string;
  appSecret: string;
  allowedOpenIds: string[];
}

interface SecretDocument {
  version: 1;
  dingtalk?: DingTalkSecret | undefined;
  feishu?: FeishuSecret | undefined;
  externalAgents?: Record<string, { bearerToken?: string | undefined }>;
}

interface RegistrationSession {
  deviceCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

interface FeishuRegistrationPoll {
  status: "waiting" | "success" | "failed" | "expired";
  appId?: string;
  appSecret?: string;
  reason?: string;
}

export interface FeishuProvisioner {
  begin(): Promise<RegistrationSession>;
  poll(deviceCode: string): Promise<FeishuRegistrationPoll>;
  cancel(deviceCode: string): void;
}

export interface ConnectionManagerConfig {
  dataDir: string;
  legacyDingTalk?: DingTalkSecret & { debug?: boolean };
  debugDingTalk?: boolean;
  fakeConnections?: boolean;
}

export class LocalSecretStore {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "secrets", "connections.json");
  }

  read(): SecretDocument {
    if (!existsSync(this.path)) return { version: 1 };
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as SecretDocument;
    if (parsed.version !== 1) throw new Error("unsupported connection secret store version");
    return parsed;
  }

  write(document: SecretDocument): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  update(mutator: (current: SecretDocument) => SecretDocument): SecretDocument {
    const next = mutator(this.read());
    this.write(next);
    return next;
  }
}

export class OfficialFeishuProvisioner implements FeishuProvisioner {
  #attempts = new Map<string, { controller: AbortController; state: FeishuRegistrationPoll }>();

  async begin(): Promise<RegistrationSession> {
    const deviceCode = `feishu-device-${ulid()}`;
    const controller = new AbortController();
    this.#attempts.set(deviceCode, { controller, state: { status: "waiting" } });
    let resolveQr!: (value: RegistrationSession) => void;
    let rejectQr!: (reason: unknown) => void;
    const qrReady = new Promise<RegistrationSession>((resolve, reject) => { resolveQr = resolve; rejectQr = reject; });
    void registerFeishuApp({
      signal: controller.signal,
      onQrCode: ({ url, expireIn }) => resolveQr({ deviceCode, verificationUrl: url, expiresInSeconds: expireIn, intervalSeconds: 1 }),
    }).then(({ appId, appSecret }) => {
      const attempt = this.#attempts.get(deviceCode);
      if (attempt) attempt.state = { status: "success", appId, appSecret };
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const attempt = this.#attempts.get(deviceCode);
      if (attempt) attempt.state = { status: "failed", reason: friendlyConnectionError(error) };
      rejectQr(error);
    });
    return qrReady;
  }

  async poll(deviceCode: string): Promise<FeishuRegistrationPoll> {
    return this.#attempts.get(deviceCode)?.state ?? { status: "failed", reason: "飞书扫码会话不存在" };
  }

  cancel(deviceCode: string): void {
    this.#attempts.get(deviceCode)?.controller.abort();
    this.#attempts.delete(deviceCode);
  }
}

export class FakeFeishuProvisioner implements FeishuProvisioner {
  #polls = 0;
  async begin(): Promise<RegistrationSession> {
    this.#polls = 0;
    return { deviceCode: "feishu-demo-device", verificationUrl: "https://example.test/mycel-feishu-demo", expiresInSeconds: 120, intervalSeconds: 0.05 };
  }
  async poll(): Promise<FeishuRegistrationPoll> {
    this.#polls += 1;
    return this.#polls < 2 ? { status: "waiting" } : { status: "success", appId: "cli_demo_feishu", appSecret: "feishu-secret-never-exposed" };
  }
  cancel(): void {}
}

class CompositeNotifier implements NotifierPort {
  constructor(private readonly delegates: NotifierPort[]) {}
  async mutationChanged(mutation: MutationView, projection: AppProjection): Promise<void> {
    await Promise.all(this.delegates.map((delegate) => delegate.mutationChanged(mutation, projection)));
  }
  async runChanged(run: RunView, projection: AppProjection): Promise<void> {
    await Promise.all(this.delegates.map((delegate) => delegate.runChanged(run, projection)));
  }
  async proposalChanged(proposal: ProductionProposal, projection: AppProjection): Promise<void> {
    await Promise.all(this.delegates.map((delegate) => delegate.proposalChanged(proposal, projection)));
  }
}

export class ConnectionManager {
  readonly #store: LocalSecretStore;
  readonly #feishuProvisioner: FeishuProvisioner;
  readonly #application: ApplicationService;
  readonly #control: ControlPlaneService;
  readonly #notifier: DelegatingNotifier;
  readonly #config: ConnectionManagerConfig;
  #dingtalk: DingTalkIntegration | undefined;
  #feishu: FeishuIntegration | undefined;
  #cancelledFeishuQr = new Set<string>();
  #localAgents: LocalAgentCandidate[] = [];
  #external = new Map<string, ExternalDiscoveryView & { bearerToken?: string }>();
  #dingView: DingTalkConnectionView = {
    id: "connection:dingtalk",
    phase: "disconnected",
    message: "尚未连接钉钉机器人",
    hasCredentials: false,
    pairingPending: false,
    cardMode: "markdown",
    updatedAt: new Date().toISOString(),
  };
  #feishuView: FeishuConnectionView = {
    id: "connection:feishu",
    phase: "disconnected",
    message: "尚未连接飞书机器人",
    hasCredentials: false,
    pairingPending: false,
    messageMode: "markdown",
    updatedAt: new Date().toISOString(),
  };

  constructor(
    application: ApplicationService,
    control: ControlPlaneService,
    notifier: DelegatingNotifier,
    config: ConnectionManagerConfig,
    feishuProvisioner: FeishuProvisioner = config.fakeConnections ? new FakeFeishuProvisioner() : new OfficialFeishuProvisioner(),
  ) {
    this.#application = application;
    this.#control = control;
    this.#notifier = notifier;
    this.#config = config;
    this.#store = new LocalSecretStore(config.dataDir);
    this.#feishuProvisioner = feishuProvisioner;
  }

  async initialize(): Promise<void> {
    let document = this.#store.read();
    if (!document.dingtalk && this.#config.legacyDingTalk) {
      document = this.#store.update((current) => ({ ...current, dingtalk: this.#config.legacyDingTalk }));
    }
    if (document.dingtalk) {
      this.#dingView = this.#publicDing("connecting", "正在恢复钉钉连接", document.dingtalk);
      try {
        await this.#connectDingTalk(document.dingtalk);
      } catch (error) {
        this.#dingView = this.#publicDing("degraded", friendlyConnectionError(error), document.dingtalk);
      }
    }
    if (document.feishu) {
      this.#feishuView = this.#publicFeishu("connecting", "正在恢复飞书连接", document.feishu);
      try {
        await this.#connectFeishu(document.feishu);
      } catch (error) {
        this.#feishuView = this.#publicFeishu("degraded", friendlyConnectionError(error), document.feishu);
      }
    }
  }

  snapshot(): ConnectionsSnapshot {
    return {
      im: { dingtalk: structuredClone(this.#dingView), feishu: structuredClone(this.#feishuView) },
      localAgents: structuredClone(this.#localAgents),
      externalDiscoveries: [...this.#external.values()].map(({ bearerToken: _secret, ...view }) => structuredClone(view)),
    };
  }

  async reconnectDingTalk(): Promise<DingTalkConnectionView> {
    const secret = this.#store.read().dingtalk;
    if (!secret) throw new Error("没有可用于重连的钉钉凭证");
    this.#dingView = this.#publicDing("connecting", "正在重新连接钉钉", secret);
    await this.#connectDingTalk(secret);
    return this.snapshot().im.dingtalk;
  }

  disconnectDingTalk(deleteCredentials = false): DingTalkConnectionView {
    this.#dingtalk?.stop();
    this.#dingtalk = undefined;
    this.#syncNotifier();
    if (deleteCredentials) this.#store.update((current) => ({ ...current, dingtalk: undefined }));
    const hasCredentials = !deleteCredentials && Boolean(this.#store.read().dingtalk);
    this.#dingView = {
      id: "connection:dingtalk",
      phase: "disconnected",
      message: deleteCredentials ? "钉钉连接与本地凭证已删除" : "钉钉已断开，可以使用已保存凭证重连",
      hasCredentials,
      pairingPending: false,
      cardMode: "markdown",
      updatedAt: new Date().toISOString(),
    };
    return this.snapshot().im.dingtalk;
  }

  async configureDingTalkManually(input: DingTalkSecret): Promise<DingTalkConnectionView> {
    const previousView = this.#dingView;
    this.#dingView = this.#publicDing("connecting", "正在验证并连接已有钉钉机器人", input);
    try {
      await this.#connectDingTalk(input, true);
      return this.snapshot().im.dingtalk;
    } catch (error) {
      const reason = friendlyConnectionError(error);
      this.#dingView = previousView.hasCredentials
        ? { ...previousView, message: `新应用验证失败，已保留原连接：${reason}`, updatedAt: new Date().toISOString() }
        : { id: "connection:dingtalk", phase: "failed", message: reason, hasCredentials: false, pairingPending: false, cardMode: "markdown", updatedAt: new Date().toISOString() };
      throw error;
    }
  }

  async beginFeishuQr(): Promise<FeishuConnectionView> {
    const sessionId = `feishuqr_${ulid()}`;
    this.#feishuView = { ...this.#feishuView, phase: "creating-session", message: "正在向飞书申请二维码", qr: undefined, updatedAt: new Date().toISOString() };
    try {
      const session = await this.#feishuProvisioner.begin();
      const imageDataUrl = await QRCode.toDataURL(session.verificationUrl, { margin: 1, width: 320, errorCorrectionLevel: "M" });
      this.#feishuView = {
        ...this.#feishuView,
        phase: "waiting-for-scan",
        message: "请使用飞书扫码并确认创建 Mycel 机器人",
        qr: { sessionId, imageDataUrl, verificationUrl: session.verificationUrl, expiresAt: new Date(Date.now() + session.expiresInSeconds * 1000).toISOString() },
        updatedAt: new Date().toISOString(),
      };
      void this.#pollFeishuQr(sessionId, session).catch((error: unknown) => {
        this.#feishuView = { ...this.#feishuView, phase: "failed", message: friendlyConnectionError(error), qr: undefined, updatedAt: new Date().toISOString() };
      });
      return this.snapshot().im.feishu;
    } catch (error) {
      this.#feishuView = { ...this.#feishuView, phase: "failed", message: friendlyConnectionError(error), qr: undefined, updatedAt: new Date().toISOString() };
      throw error;
    }
  }

  cancelFeishuQr(sessionId: string): FeishuConnectionView {
    this.#cancelledFeishuQr.add(sessionId);
    if (this.#feishuView.qr?.sessionId === sessionId) {
      this.#feishuView = { ...this.#feishuView, phase: "cancelled", message: "飞书扫码连接已取消，没有保存新凭证", qr: undefined, updatedAt: new Date().toISOString() };
    }
    return this.snapshot().im.feishu;
  }

  async reconnectFeishu(): Promise<FeishuConnectionView> {
    const secret = this.#store.read().feishu;
    if (!secret) throw new Error("没有可用于重连的飞书凭证");
    this.#feishuView = this.#publicFeishu("connecting", "正在重新连接飞书", secret);
    await this.#connectFeishu(secret);
    return this.snapshot().im.feishu;
  }

  disconnectFeishu(deleteCredentials = false): FeishuConnectionView {
    this.#feishu?.stop();
    this.#feishu = undefined;
    this.#syncNotifier();
    if (deleteCredentials) this.#store.update((current) => ({ ...current, feishu: undefined }));
    this.#feishuView = {
      id: "connection:feishu",
      phase: "disconnected",
      message: deleteCredentials ? "飞书连接与本地凭证已删除" : "飞书已断开，可以使用已保存凭证重连",
      hasCredentials: !deleteCredentials && Boolean(this.#store.read().feishu),
      pairingPending: false,
      messageMode: "markdown",
      updatedAt: new Date().toISOString(),
    };
    return this.snapshot().im.feishu;
  }

  async configureFeishuManually(input: FeishuSecret): Promise<FeishuConnectionView> {
    this.#feishuView = this.#publicFeishu("connecting", "正在验证并连接已有飞书机器人", input);
    await this.#connectFeishu(input);
    this.#store.update((current) => ({ ...current, feishu: input }));
    return this.snapshot().im.feishu;
  }

  async scanLocalAgents(): Promise<LocalAgentCandidate[]> {
    const probes = await this.#control.discoverLocalAgents();
    const projection = this.#application.getProjection();
    const now = new Date().toISOString();
    this.#localAgents = probes.map((probe) => {
      const id = probe.adapterKind === "claude-code" ? "agent:claude" : "agent:codex";
      return {
        id,
        name: probe.adapterKind === "claude-code" ? "Claude Code" : "Codex CLI",
        adapterKind: probe.adapterKind,
        available: probe.available,
        authState: probe.authState,
        ...(probe.version ? { version: probe.version } : {}),
        executable: probe.executable,
        capabilities: probe.capabilities,
        adopted: Boolean(projection.agents?.[id]),
        ...(probe.error ? { error: probe.error } : {}),
        probedAt: now,
      };
    });
    return structuredClone(this.#localAgents);
  }

  async adoptLocalAgent(candidateId: string): Promise<AgentProfile> {
    const candidate = this.#localAgents.find((item) => item.id === candidateId);
    if (!candidate) throw new Error("请先扫描本机 Agent");
    if (!candidate.available) throw new Error(candidate.error || "这个本地 Agent 当前不可用");
    const profile = this.#control.adoptLocalAgent(candidate);
    candidate.adopted = true;
    return profile;
  }

  async discoverExternalAgent(input: {
    protocol: "mcp" | "a2a";
    endpoint: string;
    bearerToken?: string;
    contractLevel?: AgentProfile["contractLevel"];
  }): Promise<ExternalDiscoveryView> {
    const endpoint = validateExternalEndpoint(input.endpoint);
    const id = `discovery_${ulid()}`;
    try {
      const discovered = input.protocol === "mcp"
        ? await discoverMcp(endpoint, input.bearerToken)
        : await discoverA2a(endpoint, input.bearerToken);
      const view: ExternalDiscoveryView & { bearerToken?: string } = {
        id,
        protocol: input.protocol,
        endpoint,
        name: discovered.name,
        status: "ready",
        capabilities: discovered.capabilities,
        contractLevel: input.contractLevel ?? "status",
        detail: discovered.detail,
        discoveredAt: new Date().toISOString(),
        ...(input.bearerToken ? { bearerToken: input.bearerToken } : {}),
      };
      this.#external.set(id, view);
      return publicDiscovery(view);
    } catch (error) {
      const view: ExternalDiscoveryView = {
        id,
        protocol: input.protocol,
        endpoint,
        name: "未验证的外部 Agent",
        status: "failed",
        capabilities: [],
        contractLevel: input.contractLevel ?? "status",
        detail: friendlyConnectionError(error),
        discoveredAt: new Date().toISOString(),
      };
      this.#external.set(id, view);
      return structuredClone(view);
    }
  }

  adoptExternalAgent(attemptId: string, displayName?: string): AgentProfile {
    const discovery = this.#external.get(attemptId);
    if (!discovery || discovery.status !== "ready") throw new Error("外部 Agent 尚未通过连接验证");
    const profile = this.#control.adoptExternalAgent({
      name: displayName?.trim() || discovery.name,
      adapterKind: discovery.protocol,
      connectionUri: discovery.endpoint,
      capabilities: discovery.capabilities,
      contractLevel: discovery.contractLevel,
    });
    if (discovery.bearerToken) {
      this.#store.update((current) => ({
        ...current,
        externalAgents: { ...(current.externalAgents ?? {}), [profile.id]: { bearerToken: discovery.bearerToken } },
      }));
    }
    discovery.status = "adopted";
    discovery.adoptedAgentId = profile.id;
    return profile;
  }

  stop(): void {
    this.#dingtalk?.stop();
    this.#feishu?.stop();
  }

  async #pollFeishuQr(sessionId: string, session: RegistrationSession): Promise<void> {
    const deadline = Date.now() + session.expiresInSeconds * 1000;
    while (Date.now() < deadline) {
      await sleep(session.intervalSeconds * 1000);
      if (this.#cancelledFeishuQr.delete(sessionId)) {
        this.#feishuProvisioner.cancel(session.deviceCode);
        return;
      }
      if (this.#feishuView.qr?.sessionId !== sessionId) return;
      const result = await this.#feishuProvisioner.poll(session.deviceCode);
      if (result.status === "waiting") continue;
      if (result.status === "expired") {
        this.#feishuView = { ...this.#feishuView, phase: "expired", message: result.reason || "二维码已过期，请刷新", qr: undefined, updatedAt: new Date().toISOString() };
        return;
      }
      if (result.status === "failed" || !result.appId || !result.appSecret) {
        this.#feishuView = { ...this.#feishuView, phase: "failed", message: result.reason || "飞书授权没有完成", qr: undefined, updatedAt: new Date().toISOString() };
        return;
      }
      this.#feishuView = { ...this.#feishuView, phase: "authorizing", message: "授权成功，正在启动飞书消息通道", qr: undefined, updatedAt: new Date().toISOString() };
      const secret: FeishuSecret = { appId: result.appId, appSecret: result.appSecret, allowedOpenIds: [] };
      this.#store.update((current) => ({ ...current, feishu: secret }));
      await this.#connectFeishu(secret);
      return;
    }
    this.#feishuView = { ...this.#feishuView, phase: "expired", message: "二维码已过期，请刷新后重新扫码", qr: undefined, updatedAt: new Date().toISOString() };
  }

  async #connectDingTalk(secret: DingTalkSecret, persistAfterStart = false): Promise<void> {
    if (this.#config.fakeConnections) {
      if (persistAfterStart) this.#store.update((current) => ({ ...current, dingtalk: secret }));
      this.#dingView = this.#publicDing("connected", "钉钉消息通道已连接；请私聊机器人完成 Owner 绑定", secret);
      this.#syncNotifier();
      return;
    }
    const integrationConfig: DingTalkIntegrationConfig = {
      clientId: secret.clientId,
      clientSecret: secret.clientSecret,
      allowedUserIds: secret.allowedUserIds,
      ownerActorId: "human:owner",
      pairFirstPrivateUser: secret.allowedUserIds.length === 0,
      debug: this.#config.debugDingTalk ?? false,
      ...(secret.robotCode ? { robotCode: secret.robotCode } : {}),
      ...(secret.cardTemplateId ? { cardTemplateId: secret.cardTemplateId } : {}),
      onOwnerPaired: async ({ userId, robotCode }) => {
        const updated: DingTalkSecret = { ...secret, allowedUserIds: [userId], robotCode };
        this.#store.update((current) => ({ ...current, dingtalk: updated }));
        this.#dingView = this.#publicDing("connected", "钉钉机器人已连接，Owner 绑定完成", updated);
      },
      approveProposal: (proposalId) => this.#control.approveProductionProposal(proposalId),
      rejectProposal: (proposalId, reason) => this.#control.rejectProductionProposal(proposalId, reason),
    };
    const integration = new DingTalkIntegration(this.#application, integrationConfig);
    this.#dingView = this.#publicDing("connecting", "正在建立钉钉 Stream 连接", secret);
    await integration.start();
    try {
      if (persistAfterStart) this.#store.update((current) => ({ ...current, dingtalk: secret }));
    } catch (error) {
      integration.stop();
      throw error;
    }
    const previous = this.#dingtalk;
    this.#dingtalk = integration;
    previous?.stop();
    this.#syncNotifier();
    this.#dingView = this.#publicDing(
      "connected",
      secret.allowedUserIds.length ? "钉钉机器人已连接" : "消息通道已连接；请私聊机器人完成 Owner 绑定",
      secret,
    );
  }

  async #connectFeishu(secret: FeishuSecret): Promise<void> {
    this.#feishu?.stop();
    this.#feishu = undefined;
    if (this.#config.fakeConnections) {
      this.#feishuView = this.#publicFeishu("connected", "飞书消息通道已连接；请私聊机器人完成 Owner 绑定", secret);
      this.#syncNotifier();
      return;
    }
    const integrationConfig: FeishuIntegrationConfig = {
      appId: secret.appId,
      appSecret: secret.appSecret,
      allowedOpenIds: secret.allowedOpenIds,
      ownerActorId: "human:owner",
      pairFirstPrivateUser: secret.allowedOpenIds.length === 0,
      onOwnerPaired: async ({ openId }) => {
        const updated: FeishuSecret = { ...secret, allowedOpenIds: [openId] };
        this.#store.update((current) => ({ ...current, feishu: updated }));
        this.#feishuView = this.#publicFeishu("connected", "飞书机器人已连接，Owner 绑定完成", updated);
      },
      approveProposal: (proposalId) => this.#control.approveProductionProposal(proposalId),
      rejectProposal: (proposalId, reason) => this.#control.rejectProductionProposal(proposalId, reason),
    };
    const integration = new FeishuIntegration(this.#application, integrationConfig);
    this.#feishuView = this.#publicFeishu("connecting", "正在建立飞书长连接", secret);
    await integration.start();
    this.#feishu = integration;
    this.#syncNotifier();
    this.#feishuView = this.#publicFeishu(
      "connected",
      secret.allowedOpenIds.length ? "飞书机器人已连接" : "消息通道已连接；请私聊机器人完成 Owner 绑定",
      secret,
    );
  }

  #syncNotifier(): void {
    const delegates: NotifierPort[] = [];
    if (this.#dingtalk) delegates.push(this.#dingtalk);
    if (this.#feishu) delegates.push(this.#feishu);
    this.#notifier.setDelegate(delegates.length ? new CompositeNotifier(delegates) : new NoopNotifier());
  }

  #publicDing(phase: ConnectionPhase, message: string, secret: DingTalkSecret): DingTalkConnectionView {
    return {
      id: "connection:dingtalk",
      phase,
      message,
      hasCredentials: true,
      pairingPending: secret.allowedUserIds.length === 0,
      cardMode: secret.cardTemplateId && secret.robotCode ? "interactive" : "markdown",
      ...(secret.allowedUserIds[0] ? { ownerUserId: maskIdentity(secret.allowedUserIds[0]) } : {}),
      clientIdHint: maskIdentity(secret.clientId),
      ...(phase === "connected" ? { connectedAt: new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  #publicFeishu(phase: ConnectionPhase, message: string, secret: FeishuSecret): FeishuConnectionView {
    return {
      id: "connection:feishu",
      phase,
      message,
      hasCredentials: true,
      pairingPending: secret.allowedOpenIds.length === 0,
      messageMode: "markdown",
      ...(secret.allowedOpenIds[0] ? { ownerOpenId: maskIdentity(secret.allowedOpenIds[0]) } : {}),
      appIdHint: maskIdentity(secret.appId),
      ...(phase === "connected" ? { connectedAt: new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    };
  }
}

async function discoverMcp(endpoint: string, bearerToken?: string): Promise<{ name: string; capabilities: string[]; detail: string }> {
  let requestId = 1;
  let sessionId: string | undefined;
  const headers = () => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-03-26",
    ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });
  const invoke = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId++, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`MCP 返回 HTTP ${response.status}`);
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const payload = await parseJsonRpcResponse(response);
    if (payload.error) throw new Error(`MCP ${method} 失败：${stringValue((payload.error as Record<string, unknown>).message) || "未知错误"}`);
    return (payload.result ?? {}) as Record<string, unknown>;
  };
  const notify = async (method: string) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`MCP ${method} 返回 HTTP ${response.status}`);
  };
  const initialized = await invoke("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mycel", version: "0.1.0" },
  });
  await notify("notifications/initialized");
  const serverInfo = recordValue(initialized.serverInfo);
  const names: string[] = [];
  for (const [method, key] of [["tools/list", "tools"], ["resources/list", "resources"], ["prompts/list", "prompts"]] as const) {
    try {
      const result = await invoke(method);
      for (const item of arrayValue(result[key])) {
        const name = stringValue(recordValue(item).name) || stringValue(recordValue(item).uri);
        if (name) names.push(`${key.slice(0, -1)}:${name}`);
      }
    } catch {
      // A server may not implement every advertised surface; successful initialize remains authoritative.
    }
  }
  const name = stringValue(serverInfo.name) || new URL(endpoint).hostname;
  const capabilities = [...new Set(["mcp", ...names])];
  return { name, capabilities, detail: `MCP 握手成功，发现 ${Math.max(0, capabilities.length - 1)} 项工具或资源` };
}

async function discoverA2a(endpoint: string, bearerToken?: string): Promise<{ name: string; capabilities: string[]; detail: string }> {
  const base = new URL(endpoint);
  const candidates = endpoint.endsWith(".json")
    ? [endpoint]
    : [new URL("/.well-known/agent-card.json", base).toString(), new URL("/.well-known/agent.json", base).toString()];
  let lastError = "没有找到 Agent Card";
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: { accept: "application/json", ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}) },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) { lastError = `Agent Card 返回 HTTP ${response.status}`; continue; }
      const card = await response.json() as Record<string, unknown>;
      const name = stringValue(card.name);
      if (!name) throw new Error("Agent Card 缺少 name");
      const skills = arrayValue(card.skills).map((item) => stringValue(recordValue(item).name) || stringValue(recordValue(item).id)).filter(Boolean);
      const declared = Object.entries(recordValue(card.capabilities))
        .filter(([, enabled]) => enabled === true)
        .map(([capability]) => capability);
      const capabilities = [...new Set(["a2a", ...declared, ...skills.map((skill) => `skill:${skill}`)])];
      return { name, capabilities, detail: `A2A Agent Card 验证成功，发现 ${skills.length} 项 Skill` };
    } catch (error) {
      lastError = friendlyConnectionError(error);
    }
  }
  throw new Error(lastError);
}

async function parseJsonRpcResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).find(Boolean);
    if (!data) throw new Error("MCP SSE 响应没有 data");
    return JSON.parse(data) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function validateExternalEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("连接地址只支持 HTTP 或 HTTPS");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["0.0.0.0", "::", "metadata.google.internal"].includes(host) || host.startsWith("169.254.") || host.startsWith("fe80:")) {
    throw new Error("连接地址不能指向链路本地或云元数据服务");
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || isPrivateIpv4(host);
  if (url.protocol === "http:" && !local) throw new Error("公网 Agent 必须使用 HTTPS");
  return url.toString();
}

function isPrivateIpv4(host: string): boolean {
  if (isIP(host) !== 4) return false;
  const [a = 0, b = 0] = host.split(".").map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function publicDiscovery(view: ExternalDiscoveryView & { bearerToken?: string }): ExternalDiscoveryView {
  const { bearerToken: _secret, ...publicView } = view;
  return structuredClone(publicView);
}

function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function recordValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function maskIdentity(value: string): string { return value.length <= 8 ? `${value.slice(0, 2)}***` : `${value.slice(0, 4)}…${value.slice(-4)}`; }
function friendlyConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(message)) return "无法连接目标服务，请检查网络或地址";
  if (/timeout|aborted/i.test(message)) return "连接超时，请稍后重试";
  return message.replace(/client[_ -]?secret\s*[:=]\s*\S+/gi, "clientSecret=[已隐藏]");
}
