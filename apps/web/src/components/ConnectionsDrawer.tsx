import React, { useEffect, useState } from "react";
import { SelectField } from "./SelectField.js";

interface DingTalkConnection {
  id: string;
  phase: string;
  message: string;
  hasCredentials: boolean;
  pairingPending: boolean;
  cardMode: "interactive" | "markdown";
  ownerUserId?: string;
  clientIdHint?: string;
  connectedAt?: string;
  updatedAt: string;
}

interface FeishuConnection {
  id: string;
  phase: string;
  message: string;
  hasCredentials: boolean;
  pairingPending: boolean;
  messageMode: "markdown";
  ownerOpenId?: string;
  appIdHint?: string;
  qr?: { sessionId: string; imageDataUrl: string; verificationUrl: string; expiresAt: string };
  connectedAt?: string;
  updatedAt: string;
}

interface LocalWorkerCandidate {
  id: string;
  name: string;
  available: boolean;
  authState: "authenticated" | "unauthenticated" | "unknown";
  version?: string;
  executable: string;
  capabilities: string[];
  adopted: boolean;
  error?: string;
}

interface ExternalDiscovery {
  id: string;
  protocol: "mcp" | "a2a";
  endpoint: string;
  name: string;
  status: "ready" | "failed" | "adopted";
  capabilities: string[];
  contractLevel: string;
  detail: string;
  adoptedAgentId?: string;
}

interface ConnectionsSnapshot {
  im: { dingtalk: DingTalkConnection; feishu: FeishuConnection };
  localAgents: LocalWorkerCandidate[];
  externalDiscoveries: ExternalDiscovery[];
}

interface DingTalkFormState {
  clientId: string;
  clientSecret: string;
  ownerUserId: string;
  robotCode: string;
  cardTemplateId: string;
}

export function ConnectionsDrawer({ open, initialTab, onClose, onError }: {
  open: boolean;
  initialTab: "im" | "agents";
  onClose: () => void;
  onError: (value: string) => void;
}) {
  const [tab, setTab] = useState<"im" | "agents">(initialTab);
  const [snapshot, setSnapshot] = useState<ConnectionsSnapshot>();
  const [busy, setBusy] = useState("");
  const [protocol, setProtocol] = useState<"mcp" | "a2a">("mcp");
  const [endpoint, setEndpoint] = useState("http://127.0.0.1:3001/mcp");
  const [bearerToken, setBearerToken] = useState("");
  const [contractLevel, setContractLevel] = useState("status");
  const [manual, setManual] = useState<DingTalkFormState>({ clientId: "", clientSecret: "", ownerUserId: "", robotCode: "", cardTemplateId: "" });
  const [feishuManual, setFeishuManual] = useState({ appId: "", appSecret: "", ownerOpenId: "" });
  const refresh = async () => setSnapshot(await getJson<ConnectionsSnapshot>("/api/connections"));

  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);
  useEffect(() => {
    if (!open) return;
    void refresh().catch((cause) => onError(errorMessage(cause)));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 800);
    return () => window.clearInterval(timer);
  }, [open]);

  async function command(name: string, action: () => Promise<unknown>): Promise<boolean> {
    setBusy(name);
    try { await action(); await refresh(); return true; }
    catch (cause) { onError(errorMessage(cause)); return false; }
    finally { setBusy(""); }
  }

  async function connectDingTalk(event: React.FormEvent) {
    event.preventDefault();
    const connected = await command("dingtalk-manual", () => postJson("/api/connections/dingtalk/manual", {
      clientId: manual.clientId,
      clientSecret: manual.clientSecret,
      allowedUserIds: manual.ownerUserId.trim() ? [manual.ownerUserId.trim()] : [],
      robotCode: manual.robotCode || undefined,
      cardTemplateId: manual.cardTemplateId || undefined,
    }));
    if (connected) setManual((current) => ({ ...current, clientSecret: "" }));
  }
  async function disconnectDingTalk(deleteCredentials = false) { await command(deleteCredentials ? "dingtalk-delete" : "dingtalk-disconnect", () => postJson("/api/connections/dingtalk/disconnect", { deleteCredentials })); }
  async function startFeishuQr() { await command("feishu-qr", () => postJson("/api/connections/feishu/qr", {})); }
  async function cancelFeishuQr() { const id = snapshot?.im.feishu.qr?.sessionId; if (id) await command("feishu-cancel", () => postJson(`/api/connections/feishu/qr/${encodeURIComponent(id)}/cancel`, {})); }
  async function disconnectFeishu(deleteCredentials = false) { await command(deleteCredentials ? "feishu-delete" : "feishu-disconnect", () => postJson("/api/connections/feishu/disconnect", { deleteCredentials })); }
  async function connectFeishu(event: React.FormEvent) {
    event.preventDefault();
    const connected = await command("feishu-manual", () => postJson("/api/connections/feishu/manual", { appId: feishuManual.appId, appSecret: feishuManual.appSecret, allowedOpenIds: feishuManual.ownerOpenId.trim() ? [feishuManual.ownerOpenId.trim()] : [] }));
    if (connected) setFeishuManual((current) => ({ ...current, appSecret: "" }));
  }
  async function scanLocal() { await command("scan", () => postJson("/api/agent-discovery/local/scan", {})); }
  async function adoptLocal(id: string) { await command(id, () => postJson(`/api/agent-discovery/local/${encodeURIComponent(id)}/adopt`, {})); }
  async function discoverExternal(event: React.FormEvent) {
    event.preventDefault();
    const discovered = await command("discover", () => postJson("/api/agent-discovery/external", { protocol, endpoint, bearerToken: bearerToken || undefined, contractLevel }));
    if (discovered) setBearerToken("");
  }
  async function adoptExternal(id: string) { await command(id, () => postJson(`/api/agent-discovery/${encodeURIComponent(id)}/adopt`, {})); }

  if (!open) return null;
  const ding = snapshot?.im.dingtalk;
  const feishu = snapshot?.im.feishu;
  const showDingTalkSetup = !ding || ding.phase !== "connected";

  return <div className="connection-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="connection-drawer" role="dialog" aria-modal="true" aria-label="连接与 Worker 纳管">
      <header><div><span className="eyebrow">CONNECTION WORKBENCH</span><h2>连接与纳管</h2><p>连接钉钉或飞书机器人，或验证本地和外部 Worker。只有验证成功的连接才会启用。</p></div><button className="drawer-close" aria-label="关闭连接工作台" onClick={onClose}>×</button></header>
      <nav className="connection-tabs"><button className={tab === "im" ? "active" : ""} onClick={() => setTab("im")}>IM 机器人</button><button className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>Worker 纳管</button></nav>
      <div className="connection-scroll">
        {tab === "im" && <>
          <section className="connection-section dingtalk-connection">
            <div className="connection-title"><div><span className={`connection-light ${ding?.phase ?? "disconnected"}`}/><div><h3>钉钉应用机器人</h3><small>{ding?.clientIdHint ?? "尚未配置"} · {ding?.cardMode === "interactive" ? "互动卡片" : "Markdown"}</small></div></div><span className={`phase ${ding?.phase ?? "disconnected"}`}>{ding?.phase ?? "loading"}</span></div>
            <p className="connection-message">{ding?.message ?? "正在读取连接状态…"}</p>
            {showDingTalkSetup && <DingTalkSetupGuide/>}
            {ding?.pairingPending && ding.phase === "connected" && <div className="pairing-note"><b>还差一步：绑定 Owner</b><p>在钉钉中私聊这个应用机器人并发送任意消息。首次私聊用户会成为本机 Owner。</p></div>}
            {showDingTalkSetup
              ? <DingTalkApplicationForm state={manual} busy={busy === "dingtalk-manual"} onChange={setManual} onSubmit={connectDingTalk}/>
              : <details className="advanced-connection"><summary>更换应用机器人</summary><DingTalkApplicationForm state={manual} busy={busy === "dingtalk-manual"} onChange={setManual} onSubmit={connectDingTalk}/></details>}
            <div className="connection-actions">
              {ding?.hasCredentials && ding.phase !== "connected" && <button disabled={busy === "dingtalk-reconnect"} onClick={() => void command("dingtalk-reconnect", () => postJson("/api/connections/dingtalk/reconnect", {}))}>使用已保存凭证重连</button>}
              {ding?.phase === "connected" && <button onClick={() => void disconnectDingTalk(false)}>断开连接</button>}
              {ding?.hasCredentials && <button className="danger" onClick={() => void disconnectDingTalk(true)}>断开并删除凭证</button>}
            </div>
          </section>
          <section className="connection-section">
            <div className="connection-title"><div><span className={`connection-light ${feishu?.phase ?? "disconnected"}`}/><div><h3>飞书机器人</h3><small>{feishu?.appIdHint ?? "尚未配置"} · Markdown</small></div></div><span className={`phase ${feishu?.phase ?? "disconnected"}`}>{feishu?.phase ?? "loading"}</span></div>
            <p className="connection-message">{feishu?.message ?? "正在读取连接状态…"}</p>
            {feishu?.qr && <div className="qr-stage feishu"><img src={feishu.qr.imageDataUrl} alt="飞书机器人授权二维码"/><div><b>用飞书扫码</b><p>扫码后按飞书授权页提示创建 Mycel 应用并授予机器人消息权限。本页面会自动更新。</p><small>有效期至 {new Date(feishu.qr.expiresAt).toLocaleTimeString("zh-CN")}</small><a href={feishu.qr.verificationUrl} target="_blank" rel="noreferrer">无法扫码？打开授权页 ↗</a></div></div>}
            {feishu?.pairingPending && feishu.phase === "connected" && <div className="pairing-note"><b>还差一步：绑定 Owner</b><p>在飞书中私聊刚创建的机器人并发送任意文本。首次私聊用户会成为本机 Owner。</p></div>}
            <div className="connection-actions">
              {(!feishu || ["disconnected", "failed", "expired", "cancelled"].includes(feishu.phase)) && <button disabled={busy === "feishu-qr"} onClick={() => void startFeishuQr()}>{busy === "feishu-qr" ? "正在生成…" : "扫码连接"}</button>}
              {feishu?.phase === "waiting-for-scan" && <button disabled={busy === "feishu-cancel"} onClick={() => void cancelFeishuQr()}>取消扫码</button>}
              {feishu?.hasCredentials && feishu.phase !== "connected" && feishu.phase !== "waiting-for-scan" && <button onClick={() => void command("feishu-reconnect", () => postJson("/api/connections/feishu/reconnect", {}))}>使用已保存凭证重连</button>}
              {feishu?.phase === "connected" && <button onClick={() => void disconnectFeishu(false)}>断开连接</button>}
              {feishu?.hasCredentials && <button className="danger" onClick={() => void disconnectFeishu(true)}>断开并删除凭证</button>}
            </div>
            <details className="advanced-connection"><summary>高级：连接已有飞书应用</summary><form onSubmit={(event) => void connectFeishu(event)}><label>App ID<input required value={feishuManual.appId} onChange={(event) => setFeishuManual({ ...feishuManual, appId: event.target.value })}/></label><label>App Secret<input required type="password" autoComplete="off" value={feishuManual.appSecret} onChange={(event) => setFeishuManual({ ...feishuManual, appSecret: event.target.value })}/></label><label>Owner Open ID（可稍后私聊绑定）<input value={feishuManual.ownerOpenId} onChange={(event) => setFeishuManual({ ...feishuManual, ownerOpenId: event.target.value })}/></label><button disabled={busy === "feishu-manual"}>{busy === "feishu-manual" ? "正在验证…" : "验证并连接"}</button></form></details>
          </section>
        </>}
        {tab === "agents" && <>
          <section className="connection-section"><div className="section-heading"><div><span className="eyebrow">LOCAL CLI</span><h3>本地 Worker</h3><p>扫描本机已安装的 CLI，检查真实路径、版本和登录状态。</p></div><button disabled={busy === "scan"} onClick={() => void scanLocal()}>{busy === "scan" ? "扫描中…" : "扫描本机"}</button></div><div className="candidate-list">{snapshot?.localAgents.map((candidate) => <article key={candidate.id}><div><span className={`connection-light ${candidate.available ? "connected" : "failed"}`}/><div><b>{candidate.name}</b><small>{candidate.version ?? candidate.error ?? "未探测"} · {candidate.authState === "authenticated" ? "已登录" : candidate.authState === "unauthenticated" ? "未登录" : "登录状态未知"}</small><code>{candidate.executable}</code></div></div><div className="candidate-capabilities">{candidate.capabilities.slice(0, 5).map((item) => <span key={item}>{item}</span>)}</div><button disabled={!candidate.available || candidate.adopted || busy === candidate.id} onClick={() => void adoptLocal(candidate.id)}>{candidate.adopted ? "已纳管" : busy === candidate.id ? "纳管中…" : "纳管"}</button></article>)}{snapshot?.localAgents.length === 0 && <Empty text="点击“扫描本机”查找 Claude Code 和 Codex CLI。"/>}</div></section>
          <section className="connection-section"><span className="eyebrow">EXTERNAL WORKER</span><h3>连接外部 Worker</h3><p>先完成协议握手和能力发现，再由你确认纳管。</p><form className="external-discovery-form" onSubmit={(event) => void discoverExternal(event)}><SelectField ariaLabel="选择外部 Worker 协议" value={protocol} onChange={(value) => setProtocol(value as "mcp" | "a2a")} options={[{ value: "mcp", label: "MCP", description: "initialize + tools/resources/prompts" }, { value: "a2a", label: "A2A", description: "读取并验证 Worker Card" }]}/><label>连接地址<input required type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)}/></label><label>Bearer Token（可选）<input type="password" autoComplete="off" value={bearerToken} onChange={(event) => setBearerToken(event.target.value)}/></label><SelectField ariaLabel="选择接入级别" value={contractLevel} onChange={setContractLevel} options={[{ value: "status", label: "状态" }, { value: "results", label: "结果" }, { value: "evidence", label: "证据" }, { value: "control", label: "控制" }]}/><button disabled={busy === "discover"}>{busy === "discover" ? "正在握手…" : "连接并发现"}</button></form><div className="discovery-list">{snapshot?.externalDiscoveries.map((item) => <article className={item.status} key={item.id}><header><span className={`phase ${item.status}`}>{item.status}</span><div><b>{item.name}</b><code>{item.protocol.toUpperCase()} · {item.endpoint}</code></div></header><p>{item.detail}</p><div className="candidate-capabilities">{item.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div>{item.status === "ready" && <button disabled={busy === item.id} onClick={() => void adoptExternal(item.id)}>{busy === item.id ? "纳管中…" : "确认纳管"}</button>}{item.status === "adopted" && <small>已进入 Graph：{item.adoptedAgentId}</small>}</article>)}</div></section>
        </>}
      </div>
    </aside>
  </div>;
}

function DingTalkSetupGuide() {
  return <div className="dingtalk-setup-guide">
    <div><span className="eyebrow">SETUP · 约 3 分钟</span><h4>连接你自己的应用机器人</h4><p>机器人名称和头像由你在钉钉中设置，Mycel 只在本机使用它的 Stream 消息通道。</p></div>
    <ol><li>创建一个钉钉应用</li><li>开启“机器人与消息推送”</li><li>接收模式选择“Stream 模式”并发布</li><li>复制 Client ID 和 Client Secret</li></ol>
    <a className="dingtalk-console-link" href="https://open-dev.dingtalk.com/" target="_blank" rel="noreferrer">打开钉钉开发者后台 ↗</a>
  </div>;
}

function DingTalkApplicationForm({ state, busy, onChange, onSubmit }: { state: DingTalkFormState; busy: boolean; onChange: (value: DingTalkFormState) => void; onSubmit: (event: React.FormEvent) => void }) {
  return <form className="dingtalk-application-form" onSubmit={(event) => void onSubmit(event)}>
    <label>Client ID<input aria-label="Client ID" required autoComplete="off" value={state.clientId} onChange={(event) => onChange({ ...state, clientId: event.target.value })}/><small>钉钉应用信息中的 AppKey</small></label>
    <label>Client Secret<input aria-label="Client Secret" required type="password" autoComplete="off" value={state.clientSecret} onChange={(event) => onChange({ ...state, clientSecret: event.target.value })}/><small>只保存在本机，不会进入 Graph 或浏览器状态</small></label>
    <button disabled={busy}>{busy ? "正在验证 Stream…" : "验证并连接"}</button>
    <details className="dingtalk-optional"><summary>可选：Owner 与互动卡片</summary><div><label>Owner User ID<input value={state.ownerUserId} onChange={(event) => onChange({ ...state, ownerUserId: event.target.value })}/><small>留空可在首次私聊时自动绑定</small></label><label>Robot Code<input value={state.robotCode} onChange={(event) => onChange({ ...state, robotCode: event.target.value })}/></label><label>Card Template ID<input value={state.cardTemplateId} onChange={(event) => onChange({ ...state, cardTemplateId: event.target.value })}/></label></div></details>
  </form>;
}

function Empty({ text }: { text: string }) { return <div className="empty"><span>∴</span><p>{text}</p></div>; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
async function getJson<T>(url: string): Promise<T> { return responseJson<T>(await fetch(url)); }
async function postJson<T = unknown>(url: string, body: unknown): Promise<T> { return responseJson<T>(await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); }
async function responseJson<T>(response: Response): Promise<T> { const json = await response.json() as T & { message?: string; error?: string }; if (!response.ok) throw new Error(json.message ?? json.error ?? `HTTP ${response.status}`); return json; }
