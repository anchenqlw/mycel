import { useEffect, useMemo, useState } from "react";
import { SelectField } from "../components/SelectField.js";
import type { RightWorkbenchResource } from "../right-workbench.js";

interface Worker {
  id: string; name: string; source: "adopted" | "native"; adapterKind: string; status: string; version?: string;
  capabilities: string[]; contractLevel: string; connectionUri?: string; lifecycle: string; defaultSpecVersionId?: string;
  controlCapabilities: { send: boolean; interrupt: boolean; resume: boolean; cancel: boolean; fork: boolean; structuredOutput: boolean };
}
interface WorkerSpec {
  schemaVersion: 1 | 2; id: string; workerId: string; version: number;
  systemPrompt: string; engine: string | { adapter: string; model?: string; effort?: string };
  skills?: Array<{ name: string; enabled: boolean; content: string }>;
  mcpServers?: Array<{ name: string; transport: string; enabled: boolean; allowedTools: string[] }>;
  tools?: Array<{ name: string; permission: string; enabled: boolean }>;
  legacySkillRefs?: string[]; legacyToolRefs?: string[]; fileRefs: string[]; lifecycle: string;
  memory?: { scope: string; resume: boolean; summaryPolicy: string };
  sessionPolicy?: { maxTurns: number; timeoutMs?: number; maxConcurrentSessions?: number };
  budget?: { maxCostUsd?: number; maxTokens?: number };
  orchestration: { enabled: boolean; maxDelegationDepth: number; maxFanOut: number };
}
interface WorkerSession {
  id: string; workerId: string; phase: string; mode: string; instruction: string; summary: string; lastEvent: string;
  workerSpecVersionId?: string; taskId?: string; workspaceId?: string; retryOf?: string; forkedFrom?: string; updatedAt: string;
}
interface LegacySession { id: string; agentId: string; phase: string; mode: string; prompt: string; summary: string; lastEvent: string; updatedAt: string }

export interface WorkersProjection {
  workers: Record<string, Worker>;
  workerSpecs: Record<string, WorkerSpec>;
  workerSessions: Record<string, WorkerSession>;
  agentSessions: Record<string, LegacySession>;
}

export function WorkersView({ state, workspaceId, onError, onOpenConnections, onOpenResource, onAskSteward }: {
  state: WorkersProjection; workspaceId: string; onError: (value: string) => void; onOpenConnections: () => void;
  onOpenResource: (resource: RightWorkbenchResource) => void; onAskSteward: (text: string) => void;
}) {
  const workers = useMemo(() => Object.values(state.workers).sort((left, right) => left.source.localeCompare(right.source) || left.name.localeCompare(right.name)), [state.workers]);
  const [selectedId, setSelectedId] = useState("");
  const [instruction, setInstruction] = useState("检查当前工作区，说明它的用途、状态和需要注意的问题");
  const [mode, setMode] = useState<"explore" | "execute">("explore");
  const selected = state.workers[selectedId] ?? workers[0];
  useEffect(() => { if (!selectedId && workers[0]) setSelectedId(workers[0].id); }, [selectedId, workers]);
  const specs = Object.values(state.workerSpecs).filter((spec) => spec.workerId === selected?.id).sort((left, right) => right.version - left.version);
  const [visibleSpecId, setVisibleSpecId] = useState("");
  const visibleSpec = state.workerSpecs[visibleSpecId] ?? state.workerSpecs[selected?.defaultSpecVersionId ?? ""] ?? specs[0];
  useEffect(() => { setVisibleSpecId(selected?.defaultSpecVersionId ?? ""); }, [selected?.id, selected?.defaultSpecVersionId]);
  const sessions = Object.values(state.workerSessions).filter((session) => session.workerId === selected?.id).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const legacySessions = Object.values(state.agentSessions).filter((session) => session.agentId === selected?.id).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  async function start(): Promise<void> {
    if (!selected) return;
    try {
      if (visibleSpec?.schemaVersion === 2) await postJson("/api/worker-sessions", { workerId: selected.id, instruction, mode, workspaceId, workerSpecVersionId: visibleSpec.id });
      else await postJson("/api/agent-sessions", { agentId: selected.id, prompt: instruction, mode, workspaceId });
    } catch (error) { onError(errorMessage(error)); }
  }

  return <section className="page workers-page">
    <header className="page-header"><span className="eyebrow">WORKER 管理</span><h1>Workers</h1><p>查看执行者、Harness 版本和 Session；需要创建或修改时，直接交给 Steward。</p></header>
    <div className="toolbar"><button onClick={onOpenConnections}>+ 纳管 Adopted Worker</button><button onClick={() => onAskSteward("为我创建一个 Native Worker。请先询问它的职责、工作区、权限和 Harness 配置。")}>+ 让 Steward 创建 Native Worker</button></div>
    <div className="split-layout worker-layout">
      <div className="agent-cards worker-cards">{workers.map((worker) => <button key={worker.id} className={selected?.id === worker.id ? "selected" : ""} onClick={() => setSelectedId(worker.id)}><div><i className={`runtime-dot ${worker.status}`}/><b>{worker.name}</b></div><span>{worker.source === "adopted" ? "Adopted Worker" : "Native Worker"}</span><small>{worker.adapterKind} · {worker.version ?? worker.lifecycle}</small></button>)}</div>
      <section className="detail-panel worker-detail">{selected ? <>
        <header className="worker-detail-header"><div><span className="eyebrow">{selected.source === "adopted" ? "ADOPTED WORKER" : "NATIVE WORKER"} · {selected.contractLevel}</span><h2>{selected.name}</h2><code>{selected.id}</code></div><span className={`phase ${selected.status}`}>{selected.status}</span></header>
        {selected.connectionUri && <p className="connection-uri">{selected.connectionUri}</p>}
        <div className="worker-capability-grid"><Metric label="LIFECYCLE" value={selected.lifecycle}/><Metric label="SPECS" value={String(specs.length)}/><Metric label="SESSIONS" value={String(sessions.length || legacySessions.length)}/><Metric label="CONTROLS" value={Object.entries(selected.controlCapabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(" · ") || "status only"}/></div>
        <div className="capabilities">{selected.capabilities.map((item) => <span key={item}>{item}</span>)}</div>
        <section className="worker-harness"><header><div><span className="eyebrow">HARNESS</span><h3>{visibleSpec ? `WorkerSpec v${visibleSpec.version}` : "未发布 WorkerSpec"}</h3></div>{specs.length > 0 && <SelectField ariaLabel="选择 WorkerSpec 版本" value={visibleSpec?.id ?? ""} onChange={setVisibleSpecId} options={specs.map((spec) => ({ value: spec.id, label: `v${spec.version}${spec.id === selected.defaultSpecVersionId ? " · 当前" : ""}` }))}/>}</header>
          {visibleSpec ? <HarnessDetails spec={visibleSpec}/> : <div className="external-contract">这个 Adopted Worker 没有 Mycel 管理的 Harness。它仍可按已验证的原生契约运行；要增加 Overlay，请告诉 Steward。</div>}
          <button className="link-button" onClick={() => onAskSteward(`修改 ${selected.name}（${selected.id}）的 Harness。请先展示当前配置和影响，再生成新的 WorkerSpec 版本。`)}>让 Steward 修改 Harness →</button>
        </section>
        {(selected.adapterKind === "claude-code" || selected.adapterKind === "codex") && <div className="session-compose worker-session-compose"><SelectField ariaLabel="选择任务模式" value={mode} onChange={(value) => setMode(value as "explore" | "execute")} options={[{ value: "explore", label: "只读检查", description: "不修改工作区" }, { value: "execute", label: "执行任务", description: "按 Harness 和权限写入" }]}/><textarea aria-label="输入 Worker 任务" value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={3}/><button onClick={() => void start()}>启动 Session</button></div>}
        <section className="worker-session-history"><header><h3>Sessions</h3><small>{sessions.length || legacySessions.length} 条记录</small></header>{sessions.map((session) => <button key={session.id} className="worker-session-row" onClick={() => onOpenResource({ kind: "worker-session", id: session.id, label: session.summary || session.lastEvent || "Worker Session" })}><span className={`phase ${session.phase}`}>{session.phase}</span><b>{session.summary || session.lastEvent}</b><small>{clock(session.updatedAt)} · {session.workerSpecVersionId ?? "legacy"}</small></button>)}{sessions.length === 0 && legacySessions.map((session) => <div key={session.id} className="worker-session-row"><span className={`phase ${session.phase}`}>{session.phase}</span><b>{session.summary || session.lastEvent}</b><small>{clock(session.updatedAt)} · compatibility session</small></div>)}{sessions.length === 0 && legacySessions.length === 0 && <p className="column-empty">还没有 Session。上方可以先发起一次只读检查。</p>}</section>
      </> : <div className="empty"><span>∴</span><p>还没有 Worker。先纳管本机/外部 Worker，或让 Steward 创建 Native Worker。</p></div>}</section>
    </div>
  </section>;
}

function HarnessDetails({ spec }: { spec: WorkerSpec }) {
  const engine = typeof spec.engine === "string" ? spec.engine : [spec.engine.adapter, spec.engine.model, spec.engine.effort].filter(Boolean).join(" · ");
  const skills = spec.schemaVersion === 2 ? spec.skills?.filter((item) => item.enabled).map((item) => item.name) ?? [] : spec.legacySkillRefs ?? [];
  const tools = spec.schemaVersion === 2 ? spec.tools?.filter((item) => item.enabled).map((item) => `${item.name} · ${item.permission}`) ?? [] : spec.legacyToolRefs ?? [];
  return <div className="harness-details"><div className="harness-summary"><Metric label="ENGINE" value={engine}/><Metric label="SKILLS" value={String(skills.length)}/><Metric label="MCP" value={String(spec.mcpServers?.filter((item) => item.enabled).length ?? 0)}/><Metric label="TOOLS" value={String(tools.length)}/></div><details><summary>System prompt</summary><p className="worker-prompt">{spec.systemPrompt}</p></details><details><summary>Skills、MCP 与 Tools</summary><div className="harness-columns"><div><b>Skills</b>{skills.map((item) => <span key={item}>{item}</span>)}</div><div><b>MCP</b>{spec.mcpServers?.filter((item) => item.enabled).map((item) => <span key={item.name}>{item.name} · {item.transport}</span>)}</div><div><b>Tools</b>{tools.map((item) => <span key={item}>{item}</span>)}</div></div></details><details><summary>Session 与编排策略</summary><p>{spec.memory ? `Memory ${spec.memory.scope} · ${spec.memory.summaryPolicy}` : "Legacy memory policy"}</p><p>{spec.sessionPolicy ? `${spec.sessionPolicy.maxTurns} turns · ${spec.sessionPolicy.maxConcurrentSessions ?? 1} concurrent` : "Session policy unavailable"}</p><p>{spec.orchestration.enabled ? `Delegation ${spec.orchestration.maxDelegationDepth}/${spec.orchestration.maxFanOut}` : "不允许委派其他 Worker"}</p></details></div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="info"><span>{label}</span><b>{value}</b></div> }
function clock(value: string) { return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }
async function postJson(url: string, body: unknown): Promise<unknown> { const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const data = await response.json() as { error?: string; message?: string }; if (!response.ok) throw new Error(data.error ?? data.message ?? `HTTP ${response.status}`); return data }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
