import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { sanitizeForPresentation } from "@mycel/domain";
import { shouldSubmitComposer } from "./composer.js";
import { shouldShowActiveDesign } from "./conversation-state.js";
import { SelectField } from "./components/SelectField.js";
import { SafeMarkdown } from "./components/SafeMarkdown.js";
import { RightWorkbench } from "./components/RightWorkbench.js";
import { ConnectionsDrawer } from "./components/ConnectionsDrawer.js";
import { WorkspaceContextBar, type WorkspaceSummary } from "./components/WorkspaceContextBar.js";
import { FailedChangeSetRecoveryAction, flowRunPresentationMessage, HistoryEventPayload, HumanTaskOpenActions, humanTaskPresentationTitle, isRecoverableChangeSetStatus, stepRunPresentationMessage, taskPresentationMessage, UnsupportedFileNotice, WorkerStepRecoveryActions } from "./components/PresentationSafety.js";
import { GraphView as UnifiedGraphView } from "./graph/GraphView.js";
import { WorkersView } from "./workers/WorkersView.js";
import type { GraphSelection } from "./graph/graph-model.js";
import { activateRightTab, closeRightTab, initialRightWorkbenchState, openResourceTab, type RightWorkbenchResource } from "./right-workbench.js";
import "./styles.css";

type Risk = "green" | "yellow" | "red";
type Surface = "now" | "graph" | "workers" | "flows" | "files" | "history" | "steward";
const primaryNavigation: Surface[] = ["steward", "now", "graph", "workers", "flows", "files", "history"];
interface GraphNode { id: string; name?: string; type: "actor" | "work" | "artifact" | "capability"; kind?: string; status?: string; source?: string; adapterKind?: string; lifecycle?: string; subgraphId?: string }
interface GraphEdge { id: string; type: string; from: string; to: string; role?: string; subgraphId?: string }
interface Mutation { id: string; correlationId: string; aggregateRisk: Risk; status: string; pendingOperationIds: string[]; appliedOperationIds: string[]; updatedAt: string; diff: { sourceMessageId: string; intentSummary: string; workTitle: string; acceptanceCriteria: string[]; operations: Array<{ operationId: string; op: string; explanation: string }> }; operationRisks: Record<string, Risk> }
interface Run { id: string; workId: string; mutationId: string; phase: string; stage: string; message: string; updatedAt: string; durationMs?: number; costUsd?: number; error?: string }
interface Evidence { artifactId: string; runId: string; kind: string; uri: string; sha256: string; summary: string; passed?: boolean }
interface Message { id: string; text: string; channel: string; occurredAt: string }
interface StewardResponse { id: string; sourceMessageId: string; kind: "answer" | "clarification"; text: string; reasoningSummary: string; occurredAt: string }
type ResourceReference = RightWorkbenchResource;
interface PlanActor { id: string; name: string; kind: "human" | "adopted-agent" | "graph-agent"; existingActorId?: string; engine?: string; prompt?: string; skills: string[]; tools: string[] }
interface PlanWorkspace { id: string; workspaceId: string; purpose: string; access: "read" | "write" }
interface PlanStep { id: string; name: string; actorId: string; prompt: string; workspaceIds: string[]; dependsOn: string[]; condition: string; join: { mode: string; quorum?: number }; timeoutMs: number; maxAttempts: number; requiredCapabilities: string[] }
interface ProductionPlan { title: string; summary: string; actors: PlanActor[]; workspaces: PlanWorkspace[]; trigger: { kind: string; intervalMs?: number; timeOfDay?: string; timezone?: string; eventType?: string; glob?: string; key?: string }; steps: PlanStep[]; permissionCeiling: string[]; budget: { maxRuntimeMs: number; maxTotalAttempts: number; maxCostUsd?: number }; acceptanceCriteria: string[] }
interface ProductionProposal { id: string; conversationId: string; sourceMessageId: string; status: "ready" | "approved" | "rejected" | "failed" | "stale"; plan: ProductionPlan; compiledFlowId: string; diagnostics: Array<{ code: string; path: string; message: string }>; createdAt: string; updatedAt: string }
interface ConversationBlock { id: string; conversationId: string; sourceMessageId?: string; kind: "answer" | "clarification" | "proposal" | "changeset" | "resource" | "command" | "run" | "human-task" | "permission" | "recovery"; title?: string; text: string; status: "active" | "resolved" | "failed"; proposalId?: string; changeSetId?: string; resource?: ResourceReference; diagnostics?: Array<{ code: string; path: string; message: string }>; createdAt: string; updatedAt: string }
interface DesignSession { id: string; conversationId: string; status: string; summary: string; decisions: string[]; openQuestion?: string; updatedAt: string }
interface Agent { id: string; name: string; source: "adopted" | "graph-native"; adapterKind: string; status: string; version?: string; capabilities: string[]; contractLevel: string; connectionUri?: string; lifecycle: string; specVersionId?: string; parentAgentId?: string; updatedAt: string }
interface AgentSpec { id: string; agentId: string; version: number; engine: string; prompt: string; skills: string[]; tools: string[]; fileRefs: string[]; canOrchestrate: boolean; maxDelegationDepth: number; maxFanOut: number }
interface AgentSession { id: string; agentId: string; adapterKind: string; phase: string; mode: string; prompt: string; summary: string; lastEvent: string; workId?: string; flowRunId?: string; specVersionId?: string; createdAt: string; updatedAt: string }
interface Worker { schemaVersion: 2; id: string; name: string; source: "adopted" | "native"; adapterKind: string; status: string; version?: string; capabilities: string[]; contractLevel: string; connectionUri?: string; lifecycle: string; defaultSpecVersionId?: string; controlCapabilities: { send: boolean; interrupt: boolean; resume: boolean; cancel: boolean; fork: boolean; structuredOutput: boolean }; updatedAt: string }
interface WorkerSpec { schemaVersion: 1 | 2; id: string; workerId: string; version: number; systemPrompt: string; engine: string | { adapter: string; model?: string; effort?: string }; skills?: Array<{ name: string; enabled: boolean; content: string }>; mcpServers?: Array<{ name: string; transport: string; enabled: boolean; allowedTools: string[] }>; tools?: Array<{ name: string; permission: string; enabled: boolean }>; legacySkillRefs?: string[]; legacyToolRefs?: string[]; fileRefs: string[]; lifecycle: string; memory?: { scope: string; resume: boolean; summaryPolicy: string }; sessionPolicy?: { maxTurns: number; timeoutMs?: number; maxConcurrentSessions?: number }; budget?: { maxCostUsd?: number; maxTokens?: number }; orchestration: { enabled: boolean; maxDelegationDepth: number; maxFanOut: number } }
interface WorkerSession { id: string; workerId: string; adapterKind: string; phase: string; mode: string; instruction: string; summary: string; lastEvent: string; workerSpecVersionId?: string; taskId?: string; attemptId?: string; workspaceId?: string; retryOf?: string; forkedFrom?: string; createdAt: string; updatedAt: string }
interface Task { id: string; version: number; title: string; description: string; status: string; ownerActorId: string; candidateWorkerIds: string[]; workspaceId: string; acceptanceCriteria: string[]; currentAttemptId?: string; attemptIds: string[]; resultSummary?: string; evidenceIds: string[]; createdAt: string; updatedAt: string }
interface TaskAttempt { id: string; taskId: string; ordinal: number; phase: string; workerId?: string; humanActorId?: string; workerSessionId?: string; retryOf?: string; replacedBy?: string; resultSummary?: string; evidenceIds: string[]; error?: string; updatedAt: string }
interface ChangeSet { id: string; title: string; intentSummary: string; aggregateRisk: Risk; status: string; operations: Array<{ id: string; kind: string; targetId?: string; dependsOn: string[] }>; impact: { resourcesCreated: ResourceReference[]; resourcesModified: ResourceReference[]; resourcesArchived: ResourceReference[]; permissionsAdded: string[]; runtimeEffects: string[]; warnings: string[] }; operationResults: Array<{ operationId: string; status: string; error?: string }>; approvedBy?: string; createdAt: string; updatedAt: string }
interface FlowStep { id: string; name: string; kind: "agent" | "human"; actorId: string; prompt: string; dependsOn: string[]; condition: "always" | "previous-succeeded" | "previous-failed"; timeoutMs: number; maxAttempts: number; join?: { mode: "all" | "any" | "quorum" | "race"; quorum?: number }; requiredCapabilities?: string[] }
interface Flow { id: string; name: string; description: string; status: string; version: number; trigger: { kind: string; intervalMs?: number }; steps: FlowStep[]; permissionCeiling: string[]; maxConcurrency?: number; budget?: { maxRuntimeMs: number; maxTotalAttempts: number; maxCostUsd?: number }; createdAt: string; updatedAt: string }
interface FlowRun { id: string; flowId: string; flowVersion: number; phase: string; triggerKind: string; currentStepIds: string[]; completedStepIds: string[]; failedStepIds: string[]; skippedStepIds?: string[]; blockedStepIds?: string[]; totalAttempts?: number; message?: string; createdAt: string; updatedAt: string }
interface StepRun { id: string; flowRunId: string; stepId: string; actorId: string; phase: string; selectedDependencyStepRunIds: string[]; activeAttemptId?: string; resultId?: string; message: string; createdAt: string; updatedAt: string }
interface StepAttempt { id: string; stepRunId: string; ordinal: number; phase: string; requestedActorId: string; producerActorId?: string; agentSessionId?: string; humanTaskId?: string; permissionLeaseId: string; error?: string; startedAt: string; completedAt?: string }
interface StepArtifact { artifactId: string; uri: string; mediaType: string; sha256: string; summary: string }
interface StepResult { id: string; flowRunId: string; stepRunId: string; attemptId: string; producerActorId: string; status: string; summary: string; output: unknown; artifacts: StepArtifact[]; error?: string; startedAt: string; completedAt: string }
interface HumanTask { id: string; flowRunId: string; stepRunId: string; attemptId: string; assignedActorId: string; claimedByActorId?: string; phase: "open" | "claimed" | "completed" | "failed" | "cancelled"; instructions: string; dependencyResultIds: string[]; dueAt?: string; createdAt: string; updatedAt: string }
interface PermissionLease { id: string; flowRunId: string; stepRunId?: string; actorId: string; capabilities: string[]; workspaceScopes: string[]; maxRuntimeMs: number; maxAttempts: number; maxCostUsd?: number; expiresAt: string; status: string }
interface PermissionRequest { id: string; flowRunId: string; stepRunId: string; actorId: string; requestedCapabilities: string[]; reason: string; phase: "open" | "approved" | "denied" | "cancelled"; createdAt: string; updatedAt: string }
interface Attention { id: string; kind: string; title: string; aggregateId: string; actorId: string; status: string; createdAt: string; updatedAt: string }
interface Projection {
  graph: { version: number; nodes: GraphNode[]; edges: GraphEdge[] };
  mutations: Record<string, Mutation>; runs: Record<string, Run>; evidence: Record<string, Evidence>;
  judgments: Array<{ id: string; kind: string; actorId: string; occurredAt: string }>;
  messages: Message[]; stewardResponses: StewardResponse[]; cards: Record<string, { state: string }>;
  agents: Record<string, Agent>; agentSpecs: Record<string, AgentSpec>; agentSessions: Record<string, AgentSession>;
  workers: Record<string, Worker>; workerSpecs: Record<string, WorkerSpec>; workerSessions: Record<string, WorkerSession>; tasks: Record<string, Task>; taskAttempts: Record<string, TaskAttempt>; changeSets: Record<string, ChangeSet>;
  flows: Record<string, Flow>; flowRuns: Record<string, FlowRun>; stepRuns: Record<string, StepRun>; stepAttempts: Record<string, StepAttempt>; stepResults: Record<string, StepResult>; humanTasks: Record<string, HumanTask>; permissionLeases: Record<string, PermissionLease>; permissionRequests: Record<string, PermissionRequest>; attention: Record<string, Attention>;
  conversationBlocks: ConversationBlock[]; designSessions: Record<string, DesignSession>; productionProposals: Record<string, ProductionProposal>;
}
interface LedgerEvent { eventId: string; eventType: string; actorId: string; aggregateId: string; correlationId: string; occurredAt: string; payload: unknown }
type Workspace = WorkspaceSummary;
interface IntentProgress { requestId: string; conversationId: string; workspaceId: string; phase: "accepted" | "preparing-workspace" | "invoking-steward" | "inspecting-resources" | "validating-result" | "composing-response" | "completed" | "failed"; label: string; startedAt: string; updatedAt: string; completedAt?: string; errorCode?: string }
interface FileEntry { name: string; path: string; kind: "file" | "directory"; size: number; modifiedAt: string; gitStatus?: string }
interface Preview { workspaceId: string; path: string; name: string; kind: "code" | "text" | "markdown" | "json"; language: string; content: string; size: number; modifiedAt: string }
type SubmitIntentResult = { kind: "answer" | "clarification"; response: StewardResponse; replayed: boolean } | { kind: "resource" | "command"; block: ConversationBlock; replayed: boolean } | { kind: "proposal"; proposal: ProductionProposal; block: ConversationBlock; replayed: boolean } | { kind: "changeset"; changeSet: ChangeSet; block: ConversationBlock; replayed: boolean } | { kind: "weave_diff"; mutation: Mutation; replayed: boolean };

const emptyState: Projection = { graph: { version: 0, nodes: [], edges: [] }, mutations: {}, runs: {}, evidence: {}, judgments: [], messages: [], stewardResponses: [], cards: {}, agents: {}, agentSpecs: {}, agentSessions: {}, workers: {}, workerSpecs: {}, workerSessions: {}, tasks: {}, taskAttempts: {}, changeSets: {}, flows: {}, flowRuns: {}, stepRuns: {}, stepAttempts: {}, stepResults: {}, humanTasks: {}, permissionLeases: {}, permissionRequests: {}, attention: {}, conversationBlocks: [], designSessions: {}, productionProposals: {} };

function App() {
  const [state, setState] = useState<Projection>(emptyState);
  const [surface, setSurface] = useState<Surface>("steward");
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [graphSelection, setGraphSelection] = useState<GraphSelection>();
  const [rightWorkbench, setRightWorkbench] = useState(initialRightWorkbenchState);
  const [rightWorkbenchCollapsed, setRightWorkbenchCollapsed] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connectionTab, setConnectionTab] = useState<"im" | "agents">("im");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace>();
  const [intentProgress, setIntentProgress] = useState<IntentProgress[]>([]);
  const [workspaceNotice, setWorkspaceNotice] = useState("");
  const submittingIntent = useRef(false);
  const mainCanvas = useRef<HTMLElement>(null);

  const refreshWorkspaces = useCallback(async () => {
    const [items, selected] = await Promise.all([getJson<Workspace[]>("/api/workspaces"), getJson<Workspace>("/api/workspaces/selected?conversationId=web%3Alocal-owner")]);
    setWorkspaces(items);
    setCurrentWorkspace(selected);
  }, []);

  useEffect(() => {
    void getJson<Projection>("/api/state").then((value) => setState(normalizeProjection(value))).catch((cause) => setError(message(cause)));
    void refreshWorkspaces().catch((cause) => setError(message(cause)));
    const stream = new EventSource("/api/events");
    stream.addEventListener("state", (event) => { setState(normalizeProjection(JSON.parse((event as MessageEvent).data) as Projection)); setConnected(true); });
    stream.addEventListener("intent-progress", (event) => setIntentProgress(JSON.parse((event as MessageEvent).data) as IntentProgress[]));
    stream.onerror = () => setConnected(false);
    return () => stream.close();
  }, [refreshWorkspaces]);
  useEffect(() => { window.scrollTo({ top: 0, left: 0 }); mainCanvas.current?.scrollTo({ top: 0, left: 0 }); }, [surface]);
  useEffect(() => {
    if (surface !== "graph") { setGraphSelection(undefined); setSelectedNodeId(""); }
  }, [surface]);

  const selectedNode = state.graph.nodes.find((node) => node.id === selectedNodeId);
  const relatedEdges = selectedNode ? state.graph.edges.filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id) : [];
  const selectedStepRun = state.stepRuns[selectedNodeId];
  const openAttention = Object.values(state.attention).filter((item) => item.status === "open");
  const activeSessions = Object.values(state.workerSessions).filter((session) => ["starting", "running", "blocked"].includes(session.phase));
  const activeFlowRuns = Object.values(state.flowRuns).filter((run) => ["queued", "running", "blocked"].includes(run.phase));
  const detailOpen = Boolean(surface === "graph" && (graphSelection || selectedNode));
  const activeRuns = Object.values(state.flowRuns).filter((run) => ["queued", "running", "blocked"].includes(run.phase));
  const openTasks = Object.values(state.humanTasks).filter((task) => task.phase === "open" || task.phase === "claimed");
  const openPermissions = Object.values(state.permissionRequests).filter((request) => request.phase === "open");
  const activeTasks = Object.values(state.tasks).filter((task) => ["ready", "running", "paused", "blocked", "awaiting-acceptance"].includes(task.status));
  const pendingChangeSets = Object.values(state.changeSets).filter((changeSet) => ["validated", "awaiting-approval", "applying", "partially-applied"].includes(changeSet.status));
  const productionBadge = activeRuns.length + activeTasks.length + openTasks.length + openPermissions.length + pendingChangeSets.length;
  const pendingMutations = Object.values(state.mutations).filter((item) => item.pendingOperationIds.length).length;

  function openRightResource(resource: ResourceReference | undefined) {
    if (!resource) return;
    setRightWorkbench((current) => openResourceTab(current, resource));
    setRightWorkbenchCollapsed(false);
  }

  function askSteward(text: string) {
    setDraft(text);
    setSurface("steward");
  }

  function closeDetails() {
    setGraphSelection(undefined);
    setSelectedNodeId("");
  }

  useEffect(() => {
    if (!detailOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeDetails(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [detailOpen]);

  async function submitIntent(event: React.FormEvent) {
    event.preventDefault();
    const submittedText = draft.trim();
    if (!submittedText || busy || submittingIntent.current || !currentWorkspace) return;
    submittingIntent.current = true;
    if (/(连接|配置|接入|绑定).*(钉钉|飞书|机器人)|(钉钉|飞书|机器人).*(连接|配置|接入|绑定)/i.test(submittedText)) {
      setConnectionTab("im"); setConnectionsOpen(true);
    } else if (/(扫描|纳管|接入|连接).*(agent|智能体|mcp|a2a)|(agent|智能体|mcp|a2a).*(扫描|纳管|接入|连接)/i.test(submittedText)) {
      setConnectionTab("agents"); setConnectionsOpen(true);
    }
    setDraft("");
    setBusy(true); setError("");
    try {
      const requestId = `web_${crypto.randomUUID()}`;
      const result = await postJson<SubmitIntentResult>("/api/intents", { text: submittedText, requestId, workspaceId: currentWorkspace.id, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      setSurface("steward");
      if (result.kind === "resource") openRightResource(result.block.resource);
    } catch (cause) {
      console.error(cause);
      setDraft((current) => current || submittedText);
      setError(friendlyError(cause));
    } finally {
      submittingIntent.current = false;
      setBusy(false);
    }
  }

  async function act(action: string, aggregateId: string) {
    setBusy(true); setError("");
    try { await postJson("/api/actions", { action, aggregateId }); }
    catch (cause) { console.error(cause); setError(friendlyError(cause)); }
    finally { setBusy(false); }
  }

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">M</span><b>MYCEL</b><small>LIVING PRODUCTION GRAPH</small></div><div className="top-actions"><button className="connection-trigger" onClick={() => setConnectionsOpen(true)}>连接与纳管</button><div className="top-status"><i className={connected ? "online" : "offline"}/>{connected ? "LIVE" : "RECONNECTING"}<span/>GRAPH v{state.graph.version}<span/>{Object.keys(state.workers).length} WORKERS</div></div></header>
    <div className={`workbench ${detailOpen ? "has-inspector" : ""} ${surface === "steward" ? `has-right-workbench ${rightWorkbenchCollapsed ? "right-workbench-collapsed" : ""}` : ""}`}>
      <aside className="sidebar">
        <nav className="primary-nav" aria-label="主菜单">
          {primaryNavigation.map((item) => {
      const count = item === "now" ? openAttention.length + pendingMutations : item === "workers" ? Object.keys(state.workers).length : item === "flows" ? Object.keys(state.flows).length : undefined;
            return <NavItem key={item} surface={item} current={surface} onSelect={setSurface} {...(count === undefined ? {} : { count })}/>;
          })}
        </nav>
      </aside>
      <main ref={mainCanvas} className={`main-canvas ${surface === "steward" ? "steward-main" : ""}`}>
        {error && <div className="recovery-banner"><div><b>这次操作没有完成</b><span>{error}</span></div><button onClick={() => setError("")}>知道了</button></div>}
        {surface === "now" && <NowView state={state} busy={busy} onAct={act} onNavigate={setSurface} onError={setError}/>}
        {surface === "graph" && (
          <UnifiedGraphView
            state={state}
            selected={selectedNodeId}
            onSelect={setSelectedNodeId}
            onInspect={(selection) => {
              setGraphSelection(selection);
            }}
          />
        )}
        {surface === "workers" && (
          <WorkersView
            state={state}
            workspaceId={currentWorkspace?.id ?? "repository"}
            onError={setError}
            onOpenResource={openRightResource}
            onAskSteward={askSteward}
            onOpenConnections={() => {
              setConnectionTab("agents");
              setConnectionsOpen(true);
            }}
          />
        )}
        {surface === "flows" && <FlowsView state={state} onError={setError}/>}
        {surface === "files" && <FilesView currentWorkspaceId={currentWorkspace?.id ?? "repository"} onWorkspaceChange={(workspace) => { setCurrentWorkspace(workspace); setWorkspaceNotice(`Workspace 已切换至 ${workspace.name}${workspace.branch ? ` · ${workspace.branch}` : ""}`); }} onError={setError}/>}
        {surface === "history" && <HistoryView state={state} onError={setError}/>}
        {surface === "steward" && <StewardView state={state} busy={busy} draft={draft} setDraft={setDraft} onSubmit={submitIntent} onAct={act} onOpenResource={openRightResource} onAskSteward={askSteward} onError={setError} workspaces={workspaces} currentWorkspace={currentWorkspace} intentProgress={intentProgress} workspaceNotice={workspaceNotice} onWorkspaceSelected={(workspace) => { setCurrentWorkspace(workspace); setWorkspaceNotice(`Workspace 已切换至 ${workspace.name}${workspace.branch ? ` · ${workspace.branch}` : ""}`); void refreshWorkspaces(); }} onRefreshWorkspaces={refreshWorkspaces}/>}
      </main>
      {surface === "steward" && <RightWorkbench
        state={rightWorkbench}
        collapsed={rightWorkbenchCollapsed}
        productionBadge={productionBadge}
        onActivate={(key) => setRightWorkbench((current) => activateRightTab(current, key))}
        onClose={(key) => setRightWorkbench((current) => closeRightTab(current, key))}
        onToggleCollapsed={() => setRightWorkbenchCollapsed((value) => !value)}
        renderPanel={(tab) => tab.kind === "production" ? <LiveProductionPanel state={state} onOpenResource={openRightResource} onAskSteward={askSteward} onError={setError}/> : <ResourceInspector state={state} resource={tab.resource} onNavigate={(target) => setSurface(target)} onAskSteward={askSteward} onError={setError}/>}
      />}
      {detailOpen && <><button className="inspector-backdrop" aria-label="关闭详情" onClick={closeDetails}/><aside className="inspector" aria-label="详情面板"><header className="inspector-header"><span className="eyebrow">详情</span><button aria-label="关闭详情面板" onClick={closeDetails}>×</button></header>{surface === "graph" && graphSelection ? <><h3>{graphSelection.label}</h3><code>{graphSelection.id}</code><Info label="类型" value={graphSelection.kind}/><Info label="状态" value={graphSelection.status}/><Info label="关系" value={`${graphSelection.relations.length} 条`}/><div className="edge-mini">{graphSelection.relations.slice(0, 16).map((relation) => <button key={relation.id}><b>{relation.type}</b><span>{relation.direction === "out" ? "→" : "←"} {relation.targetLabel}</span></button>)}</div></> : selectedNode ? <><h3>{selectedNode.name ?? selectedNode.id}</h3><code>{selectedNode.id}</code><Info label="类型" value={`${selectedNode.type} · ${selectedNode.kind ?? "-"}`}/><Info label="状态" value={selectedStepRun?.phase ?? selectedNode.status ?? "-"}/><Info label="来源" value={selectedNode.source ?? selectedNode.subgraphId ?? "core graph"}/>{selectedStepRun && <StepRunInspector state={state} stepRun={selectedStepRun}/>}<Info label="关系" value={`${relatedEdges.length} 条`}/><div className="edge-mini">{relatedEdges.slice(0, 12).map((edge) => <button key={edge.id} onClick={() => setSelectedNodeId(edge.from === selectedNode.id ? edge.to : edge.from)}><b>{edge.type}</b><span>{edge.from === selectedNode.id ? `→ ${edge.to}` : `← ${edge.from}`}</span></button>)}</div></> : null}</aside></>}
    </div>
    <ConnectionsDrawer open={connectionsOpen} initialTab={connectionTab} onClose={() => setConnectionsOpen(false)} onError={setError}/>
  </div>;
}

function NowView({ state, busy, onAct, onNavigate, onError }: { state: Projection; busy: boolean; onAct: (action: string, id: string) => void; onNavigate: (surface: Surface) => void; onError: (value: string) => void }) {
  const mutations = Object.values(state.mutations).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const flowRuns = Object.values(state.flowRuns).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const humans = state.graph.nodes.filter((node) => node.type === "actor" && node.kind === "human");
  const [actorId, setActorId] = useState("human:owner");
  const tasks = Object.values(state.humanTasks).filter((task) => task.assignedActorId === actorId || task.claimedByActorId === actorId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const openTasks = tasks.filter((task) => task.phase === "open");
  const claimedTasks = tasks.filter((task) => task.phase === "claimed" && task.claimedByActorId === actorId);
  const permissionRequests = Object.values(state.permissionRequests).filter((item) => item.phase === "open");
  const controlTasks = Object.values(state.tasks).filter((task) => ["ready", "running", "paused", "blocked", "awaiting-acceptance"].includes(task.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const changeSets = Object.values(state.changeSets).filter((item) => item.status === "awaiting-approval").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  async function permissionAction(request: PermissionRequest, action: "approve" | "deny") { try { await postJson(`/api/permission-requests/${encodeURIComponent(request.id)}/${action}`, action === "approve" ? { actorId: "human:owner" } : { actorId: "human:owner", reason: "Denied from Now" }); } catch (cause) { onError(message(cause)); } }
  return <Page eyebrow="待办与审批" title="Now" subtitle="处理分配给你的任务、权限申请和待确认事项。">
    <div className="inbox-toolbar"><label>当前处理人<SelectField ariaLabel="选择处理人" value={actorId} onChange={setActorId} options={humans.map((human) => ({ value: human.id, label: human.name ?? human.id }))}/></label><span>{openTasks.length + claimedTasks.length} 项需要处理</span></div>
    <div className="now-columns">
      <NowColumn title="待领取" count={openTasks.length}>{openTasks.map((task) => <HumanTaskCard key={task.id} state={state} task={task} actorId={actorId} onError={onError}/>)}</NowColumn>
      <NowColumn title="由我处理" count={claimedTasks.length}>{claimedTasks.map((task) => <HumanTaskCard key={task.id} state={state} task={task} actorId={actorId} onError={onError}/>)}</NowColumn>
      <NowColumn title="等待批准" count={permissionRequests.length + changeSets.length + mutations.filter((item) => item.pendingOperationIds.length).length}>{changeSets.map((changeSet) => <article className="attention-card" key={changeSet.id}><RiskBadge risk={changeSet.aggregateRisk}/><h4>{changeSet.title}</h4><p>{changeSet.intentSummary}</p><small>{changeSet.operations.length} 项变更 · 在 Steward 右侧工作台处理</small><button onClick={() => onNavigate("steward")}>打开 Steward</button></article>)}{permissionRequests.map((request) => <article className="attention-card" key={request.id}><RiskBadge risk="red"/><h4>{request.requestedCapabilities.join(", ")}</h4><p>{request.reason}</p><small>{agentName(state, request.actorId)} · {request.stepRunId}</small><div className="inline-actions"><button onClick={() => void permissionAction(request, "approve")}>批准租约</button><button onClick={() => void permissionAction(request, "deny")}>拒绝</button></div></article>)}{mutations.filter((item) => item.pendingOperationIds.length).map((mutation) => <article className="attention-card" key={mutation.id}><RiskBadge risk={mutation.aggregateRisk}/><h4>{mutation.diff.workTitle}</h4><p>{mutation.diff.intentSummary}</p><small>{mutation.pendingOperationIds.length} graph operations pending</small><div className="inline-actions"><button disabled={busy} onClick={() => onAct("approve", mutation.id)}>批准</button><button disabled={busy} onClick={() => onAct("reject", mutation.id)}>拒绝</button></div></article>)}</NowColumn>
      <NowColumn title="在跑" count={flowRuns.filter((item) => ["queued", "running", "blocked"].includes(item.phase)).length + controlTasks.length}>{controlTasks.map((task) => <SignalCard key={task.id} title={task.title} meta={`Task · ${task.status}`} text={taskPresentationMessage(task)}/>)}{flowRuns.filter((item) => ["queued", "running", "blocked"].includes(item.phase)).map((item) => <SignalCard key={item.id} title={state.flows[item.flowId]?.name ?? item.flowId} meta={`Flow v${item.flowVersion} · ${item.phase}`} text={item.message ?? `${item.completedStepIds.length} steps completed`}/>)}</NowColumn>
      <NowColumn title="最近完成" count={tasks.filter((item) => item.phase === "completed").length}>{tasks.filter((item) => item.phase === "completed").slice(0, 6).map((task) => <SignalCard key={task.id} title={state.stepRuns[task.stepRunId]?.message ?? "Human task completed"} meta={clock(task.updatedAt)} text={task.instructions}/>)}</NowColumn>
    </div><button className="link-button" onClick={() => onNavigate("history")}>查看完整历史 →</button>
  </Page>;
}


function FlowsView({ state, onError }: { state: Projection; onError: (value: string) => void }) {
  const agents = Object.values(state.agents).filter((agent) => agent.status !== "offline");
  const humans = state.graph.nodes.filter((node) => node.type === "actor" && node.kind === "human");
  const flows = Object.values(state.flows).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [showCreate, setShowCreate] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState("");
  async function flowAction(flow: Flow, action: "publish" | "pause" | "trigger") { try { await postJson(`/api/flows/${encodeURIComponent(flow.id)}/${action}`, {}); } catch (cause) { onError(message(cause)); } }
  return <Page eyebrow="流程与运行" title="Flows" subtitle="查看和运行已发布流程；打开运行记录检查每个步骤的结果。"><div className="toolbar"><button onClick={() => setShowCreate(!showCreate)}>+ 创建协作流程</button></div>{showCreate && <CreateFlowForm agents={agents} humans={humans} onDone={() => setShowCreate(false)} onError={onError}/>}<div className="flow-list">{flows.map((flow) => { const runs = Object.values(state.flowRuns).filter((run) => run.flowId === flow.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); return <article key={flow.id}><header><div><span className={`phase ${flow.status}`}>{flow.status}</span><h3>{flow.name}</h3><p>{flow.description}</p></div><code>v{flow.version}</code></header><div className="flow-pipeline">{flow.steps.map((step) => <span key={step.id}><b>{step.name}</b><small>{step.kind} · {agentName(state, step.actorId)}</small><small>{step.dependsOn.length ? `${step.join?.mode ?? "all"} ← ${step.dependsOn.join(", ")}` : "起始步骤"}</small></span>)}</div><footer><span>{flow.trigger.kind} · 并发 {flow.maxConcurrency ?? 4} · {flow.permissionCeiling.join(", ") || "无写入权限"}</span><div>{flow.status === "draft" && <button onClick={() => void flowAction(flow, "publish")}>发布</button>}{flow.status === "published" && <><button onClick={() => void flowAction(flow, "trigger")}>立即运行</button><button onClick={() => void flowAction(flow, "pause")}>暂停</button></>}</div></footer>{runs.slice(0, 5).map((run) => <button className={`flow-run ${selectedRunId === run.id ? "selected" : ""}`} key={run.id} onClick={() => setSelectedRunId(run.id)}><span className={`phase ${run.phase}`}>{run.phase}</span><code>{run.id}</code><small>{run.completedStepIds.length}/{flow.steps.length} 个步骤 · {run.totalAttempts ?? 0} 次尝试 · {clock(run.updatedAt)}</small></button>)}</article>; })}{flows.length === 0 && <Empty text="还没有流程。点击“创建协作流程”开始设置参与者和步骤。"/>}</div>{selectedRunId && state.flowRuns[selectedRunId] && <RunDetail state={state} run={state.flowRuns[selectedRunId]} onError={onError}/>}</Page>;
}

function CreateFlowForm({ agents, humans, onDone, onError }: { agents: Agent[]; humans: GraphNode[]; onDone: () => void; onError: (value: string) => void }) {
  const first = agents.find((agent) => agent.id === "agent:claude")?.id ?? agents.find((agent) => agent.adapterKind === "claude-code")?.id ?? agents[0]?.id ?? "agent:claude"; const second = agents.find((agent) => agent.adapterKind === "codex")?.id ?? first;
  const [name, setName] = useState("Multi-lane Repository Review"); const [description, setDescription] = useState("Claude 与 Codex 并行分析，由人完成判断，再由 Worker 汇总所有成果。"); const [write, setWrite] = useState(false); const [humanActorId, setHumanActorId] = useState(humans[0]?.id ?? "human:owner");
  async function create(event: React.FormEvent) { event.preventDefault(); const id = `flow:${Date.now().toString(36)}`; const read = ["repository-read"]; try { await postJson("/api/flows", { id, name, description, status: "draft", version: 0, trigger: { kind: "manual" }, permissionCeiling: write ? [...read, "repository-write"] : read, maxConcurrency: 4, budget: { maxRuntimeMs: 1800000, maxTotalAttempts: 20 }, steps: [{ id: "research", name: "Claude 并行分析", kind: "agent", actorId: first, prompt: "分析当前仓库的结构、用途和主要风险，输出结构化摘要。", dependsOn: [], condition: "always", join: { mode: "all" }, requiredCapabilities: read, timeoutMs: 180000, maxAttempts: 2 }, { id: "inspect", name: "Codex 并行复核", kind: "agent", actorId: second, prompt: "独立检查当前仓库，指出最重要的风险、证据和下一步。", dependsOn: [], condition: "always", join: { mode: "all" }, requiredCapabilities: read, timeoutMs: 180000, maxAttempts: 2 }, { id: "human-review", name: "Human 判断", kind: "human", actorId: humanActorId, prompt: "阅读两路 Agent 成果，给出是否继续和需要强调的结论。", dependsOn: ["research", "inspect"], condition: "previous-succeeded", join: { mode: "all" }, requiredCapabilities: [], timeoutMs: 86400000, maxAttempts: 2 }, { id: "synthesize", name: "Agent 最终汇总", kind: "agent", actorId: first, prompt: "综合所有 Agent 分析和 Human 判断，输出最终可执行结论。", dependsOn: ["research", "inspect", "human-review"], condition: "previous-succeeded", join: { mode: "all" }, requiredCapabilities: read, timeoutMs: 180000, maxAttempts: 2 }] }); onDone(); } catch (cause) { onError(message(cause)); } }
  return <form className="compose-panel" onSubmit={create}><label>流程名称<input value={name} onChange={(event) => setName(event.target.value)}/></label><label>人工审核人<SelectField ariaLabel="选择人工审核人" value={humanActorId} onChange={setHumanActorId} options={humans.map((human) => ({ value: human.id, label: human.name ?? human.id }))}/></label><label className="wide">目标<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2}/></label><label className="checkbox"><input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)}/>允许流程写入仓库</label><button>创建 4 步草稿</button></form>;
}

function FilesView({ currentWorkspaceId, onWorkspaceChange, onError }: { currentWorkspaceId: string; onWorkspaceChange: (workspace: Workspace) => void; onError: (value: string) => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [selectedFile, setSelectedFile] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  useEffect(() => { void getJson<Workspace[]>("/api/workspaces").then(setWorkspaces).catch((cause) => onError(message(cause))); }, [onError]);
  useEffect(() => { setPath(""); setPreview(undefined); setSelectedFile(""); }, [currentWorkspaceId]);
  useEffect(() => { setLoading(true); void getJson<FileEntry[]>(`/api/files/tree?workspaceId=${encodeURIComponent(currentWorkspaceId)}&path=${encodeURIComponent(path)}`).then(setEntries).catch((cause) => onError(message(cause))).finally(() => setLoading(false)); }, [currentWorkspaceId, path, onError]);
  async function selectWorkspace(workspaceId: string) { try { const selected = await postJson<Workspace>(`/api/workspaces/${encodeURIComponent(workspaceId)}/select`, { conversationId: "web:local-owner" }); onWorkspaceChange(selected); } catch (cause) { onError(message(cause)); } }
  async function openEntry(entry: FileEntry) { if (entry.kind === "directory") { setPath(entry.path); setPreview(undefined); return; } setSelectedFile(entry.path); setPreviewError(""); try { setPreview(await getJson<Preview>(`/api/files/preview?workspaceId=${encodeURIComponent(currentWorkspaceId)}&path=${encodeURIComponent(entry.path)}`)); } catch (cause) { setPreview(undefined); setPreviewError(message(cause)); } }
  async function systemOpen() { try { await postJson("/api/files/open", { workspaceId: currentWorkspaceId, path: selectedFile }); } catch (cause) { onError(message(cause)); } }
  return <Page eyebrow="工作区文件" title="Files" subtitle="浏览当前 Workspace；文本文件可直接预览，其他格式使用系统应用打开。">
    <div className="file-toolbar"><SelectField ariaLabel="选择工作区" value={currentWorkspaceId} onChange={(value) => void selectWorkspace(value)} options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name, description: workspace.kind === "worktree" ? "工作树" : workspace.kind === "directory" ? "普通文件夹" : workspace.branch ?? "Git 仓库" }))}/><button onClick={() => setPath(path.split("/").slice(0, -1).join("/"))} disabled={!path}>↑ 上一级</button><code>/{path}</code></div>
    <div className="file-layout"><div className="file-tree">{loading && <div className="loading">正在读取…</div>}{entries.map((entry) => <button key={entry.path} onClick={() => void openEntry(entry)} className={selectedFile === entry.path ? "selected" : ""}><i>{entry.kind === "directory" ? "▸" : fileIcon(entry.name)}</i><span>{entry.name}</span>{entry.gitStatus && <em>{entry.gitStatus}</em>}<small>{entry.kind === "file" ? formatBytes(entry.size) : "目录"}</small></button>)}</div><div className="preview-panel">{preview ? <><header><div><b>{preview.name}</b><small>{preview.language} · {formatBytes(preview.size)}</small></div><button onClick={() => void systemOpen()}>用系统应用打开 ↗</button></header>{preview.kind === "markdown" ? <MarkdownPreview content={preview.content}/> : <pre><code>{preview.content}</code></pre>}</> : previewError ? <UnsupportedFileNotice relativePath={selectedFile} error={previewError} onOpen={() => void systemOpen()}/> : <Empty text="选择代码、纯文本、Markdown 或 JSON 文件进行预览。"/>}</div></div>
  </Page>;
}

function HistoryView({ state, onError }: { state: Projection; onError: (value: string) => void }) {
  const [events, setEvents] = useState<LedgerEvent[]>([]); const [filter, setFilter] = useState("");
  useEffect(() => { void getJson<LedgerEvent[]>("/api/history").then(setEvents).catch((cause) => onError(message(cause))); }, [state.graph.version, state.agentSessions, state.flowRuns, state.stepRuns, state.humanTasks, state.permissionRequests, onError]);
  const visible = events.map((event) => ({ ...event, payload: sanitizeForPresentation(event.payload) })).filter((event) => !filter || `${event.eventType} ${event.actorId} ${event.aggregateId} ${event.correlationId} ${JSON.stringify(event.payload)}`.toLowerCase().includes(filter.toLowerCase()));
  return <Page eyebrow="执行历史" title="History" subtitle="按事件类型或关联 ID 查找历史记录，并展开查看详细结果。"><div className="history-toolbar"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索事件、参与者或关联 ID…"/><span>{visible.length} 条记录</span></div><div className="timeline">{[...visible].reverse().map((event) => <article key={event.eventId}><time>{new Date(event.occurredAt).toLocaleString("zh-CN")}</time><i/><div><span className="event-type">{event.eventType}</span><b>{event.aggregateId}</b><small>{event.actorId} · {event.correlationId}</small><details><summary>查看事件详情</summary><HistoryEventPayload payload={event.payload}/></details></div></article>)}</div></Page>;
}

function StewardView({ state, busy, draft, setDraft, onSubmit, onAct, onOpenResource, onAskSteward, onError, workspaces, currentWorkspace, intentProgress, workspaceNotice, onWorkspaceSelected, onRefreshWorkspaces }: { state: Projection; busy: boolean; draft: string; setDraft: (value: string) => void; onSubmit: (event: React.FormEvent) => void; onAct: (action: string, id: string) => void; onOpenResource: (resource: ResourceReference) => void; onAskSteward: (text: string) => void; onError: (value: string) => void; workspaces: Workspace[]; currentWorkspace: Workspace | undefined; intentProgress: IntentProgress[]; workspaceNotice: string; onWorkspaceSelected: (workspace: Workspace) => void; onRefreshWorkspaces: () => Promise<void> }) {
  const conversation = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const positioned = useRef(false);
  const mutations = Object.values(state.mutations);
  const activeDesignCandidate = Object.values(state.designSessions).filter((item) => item.status === "clarifying").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const latestMessage = state.messages[state.messages.length - 1];
  const activeDesign = activeDesignCandidate && shouldShowActiveDesign(activeDesignCandidate.updatedAt, latestMessage?.occurredAt) ? activeDesignCandidate : undefined;
  const messageIds = new Set(state.messages.map((item) => item.id));
  const orphanProgress = intentProgress.filter((item) => !messageIds.has(item.requestId) && !["completed", "failed"].includes(item.phase));
  useEffect(() => {
    const element = conversation.current;
    if (!element || (positioned.current && !followLatest.current)) return;
    const frame = requestAnimationFrame(() => element.scrollTo({ top: element.scrollHeight, behavior: positioned.current ? "smooth" : "auto" }));
    positioned.current = true;
    return () => cancelAnimationFrame(frame);
  }, [state.messages.length, state.conversationBlocks.length, activeDesign?.updatedAt, busy]);
  function handleConversationScroll() {
    const element = conversation.current;
    if (!element) return;
    followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
  }
  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
  async function trigger(flowId: string) { try { await postJson(`/api/flows/${encodeURIComponent(flowId)}/trigger`, {}); } catch (cause) { onError(friendlyError(cause)); } }
  return <section className="steward-workspace">
    <header className="steward-hero"><div><span className="eyebrow">STEWARD 对话工作台</span><h1>告诉 Steward 你想完成什么</h1><p>直接描述任务、提出问题，或让 Steward 帮你创建并运行协作流程。</p></div><div className="steward-health"><i className="online"/><b>Steward 可用</b><small>由 Claude Code 提供本地执行</small></div></header>
    <div className="conversation-log steward-conversation" ref={conversation} onScroll={handleConversationScroll} data-testid="steward-conversation">
      {state.messages.length === 0 && <div className="welcome-card"><span>可以这样开始</span><h2>输入一个问题或任务目标</h2><p>我可以查看当前资源、回答问题，或先与你确认关键条件，再创建需要长期运行的协作流程。</p><div className="starter-row">{["当前仓库是什么？", "打开 README", "创建一个每天运行并由我审批的流程"].map((text) => <button key={text} onClick={() => setDraft(text)}>{text}</button>)}</div></div>}
      {state.messages.map((item) => {
        const blocks = state.conversationBlocks.filter((block) => block.sourceMessageId === item.id);
        const fallbackResponses = blocks.length ? [] : state.stewardResponses.filter((response) => response.sourceMessageId === item.id);
        const progress = intentProgress.find((candidate) => candidate.requestId === item.id);
        return <React.Fragment key={item.id}><div className="chat human"><span>YOU · {clock(item.occurredAt)} · {item.channel}</span><p>{item.text}</p></div>{progress && <IntentProgressCard progress={progress}/>} {fallbackResponses.map((response) => <div className="chat agent" key={response.id}><span>STEWARD · {response.kind}</span><SafeMarkdown content={response.text}/></div>)}{blocks.map((block) => <ConversationBlockCard key={block.id} state={state} block={block} busy={busy} onAct={onAct} onOpenResource={onOpenResource} onAskSteward={onAskSteward} onTrigger={(flowId) => void trigger(flowId)} onError={onError}/>)}{mutations.filter((mutation) => mutation.diff.sourceMessageId === item.id).map((mutation) => <div className="chat agent mutation-chat legacy-card" key={mutation.id}><span>LEGACY GRAPH DIFF</span><RiskBadge risk={mutation.aggregateRisk}/><h4>{mutation.diff.workTitle}</h4><SafeMarkdown content={mutation.diff.intentSummary}/>{mutation.pendingOperationIds.length > 0 && <div className="inline-actions"><button disabled={busy} onClick={() => onAct("approve", mutation.id)}>批准并执行</button><button disabled={busy} onClick={() => onAct("reject", mutation.id)}>拒绝</button></div>}</div>)}</React.Fragment>;
      })}
      {activeDesign && <DesignSessionCard session={activeDesign}/>}
      {orphanProgress.map((progress) => <IntentProgressCard key={progress.requestId} progress={progress}/>)}
      {workspaceNotice && <div className="workspace-notice"><span>CONTEXT</span>{workspaceNotice}</div>}
    </div>
    <form className="conversation-composer" onSubmit={onSubmit}>
      <textarea aria-label="给 Steward 发送消息" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder="输入问题、任务目标或要调整的流程…" rows={3}/>
      <footer><WorkspaceContextBar workspaces={workspaces} current={currentWorkspace} disabled={busy} onRefresh={onRefreshWorkspaces} onSelected={onWorkspaceSelected} onError={onError}/><span className={busy ? "composer-status busy" : "composer-status"} aria-live="polite">{busy ? "Steward 正在处理；进度显示在对话中" : "Enter 发送 · Shift+Enter 换行 · 高风险操作会先请你确认"}</span><button disabled={busy || !draft.trim() || !currentWorkspace}>{busy ? "处理中…" : "发送 →"}</button></footer>
    </form>
  </section>;
}

function IntentProgressCard({ progress }: { progress: IntentProgress }) {
  const terminal = progress.phase === "completed" || progress.phase === "failed";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (terminal) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [terminal]);
  const end = progress.completedAt ? Date.parse(progress.completedAt) : now;
  const elapsed = Math.max(0, end - Date.parse(progress.startedAt));
  return <div className={`intent-progress-card ${progress.phase}`} aria-live="polite">
    <div className="intent-orbit" aria-hidden="true"><i/><i/><i/></div>
    <div><span>STEWARD · {terminal ? "STATUS" : "WORKING"}</span><b>{progress.label}</b>{elapsed >= 3_000 && <small>{formatDuration(elapsed)}{!terminal && elapsed >= 8_000 ? " · 你可以继续浏览其他页面" : ""}</small>}</div>
  </div>;
}

function DesignSessionCard({ session }: { session: DesignSession }) {
  return <article className="design-session-card semantic-card semantic-clarification">
    <header><span>正在设计</span><div><small>{session.decisions.length} 项已确认</small><h3>{session.summary || "继续澄清协作方案"}</h3></div></header>
    {session.openQuestion && <div className="design-open-question"><span>待确认</span><p>{session.openQuestion}</p></div>}
    <footer>直接在下方输入框回答，Steward 会从这里继续。</footer>
  </article>;
}

function LiveProductionPanel({ state, onOpenResource, onAskSteward, onError }: { state: Projection; onOpenResource: (resource: ResourceReference) => void; onAskSteward: (text: string) => void; onError: (value: string) => void }) {
  const recentRuns = Object.values(state.flowRuns).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const openTasks = Object.values(state.humanTasks).filter((task) => task.phase === "open" || task.phase === "claimed");
  const openPermissions = Object.values(state.permissionRequests).filter((request) => request.phase === "open");
  const activeRuns = recentRuns.filter((run) => ["queued", "running", "blocked"].includes(run.phase));
  const tasks = Object.values(state.tasks).filter((task) => ["ready", "running", "paused", "blocked", "awaiting-acceptance", "failed"].includes(task.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const sessions = Object.values(state.workerSessions).filter((session) => ["starting", "running", "blocked"].includes(session.phase)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const changeSets = Object.values(state.changeSets).filter((item) => ["awaiting-approval", "applying", "partially-applied", "failed"].includes(item.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const risk: Risk = openPermissions.length || changeSets.some((item) => item.aggregateRisk === "red" && item.status === "awaiting-approval") || recentRuns.some((run) => run.phase === "failed") ? "red" : openTasks.length || tasks.some((task) => ["blocked", "failed"].includes(task.status)) || recentRuns.some((run) => run.phase === "blocked") ? "yellow" : "green";
  async function handleHumanTask(task: HumanTask) {
    try {
      if (task.phase === "open") await postJson(`/api/human-tasks/${encodeURIComponent(task.id)}/claim`, { actorId: "human:owner" });
      else await postJson(`/api/human-tasks/${encodeURIComponent(task.id)}/complete`, { actorId: "human:owner", summary: "已在 Steward 工作栏中审阅上游分析，报告包含变更摘要与风险，同意继续。", output: { decision: "approved", channel: "steward-workbench" }, files: [] });
    } catch (cause) { onError(friendlyError(cause)); }
  }
  if (recentRuns.length === 0 && tasks.length === 0 && sessions.length === 0 && changeSets.length === 0 && openTasks.length === 0 && openPermissions.length === 0) return <div className="production-empty"><RiskBadge risk="green"/><h3>当前没有运行中的工作</h3><p>创建 Task、启动 Worker Session 或运行 Flow 后，状态和待处理事项会显示在这里。</p></div>;
  return <div className="live-production-panel"><header><div><span className="eyebrow">LIVE PRODUCTION</span><h3>{activeRuns.length + sessions.length} 个运行中 · {openTasks.length + openPermissions.length + changeSets.filter((item) => item.status === "awaiting-approval").length} 个待处理</h3></div><RiskBadge risk={risk}/></header><div className="production-details">
    {changeSets.map((item) => <article className="semantic-card changeset-mini" key={item.id}><header><RiskBadge risk={item.aggregateRisk}/><b>{item.title}</b></header><p>{item.intentSummary}</p>{isRecoverableChangeSetStatus(item.status) && <FailedChangeSetRecoveryAction changeSetId={item.id} title={item.title} status={item.status} onAskSteward={onAskSteward}/>}<button onClick={() => onOpenResource({ kind: "changeset", id: item.id, label: item.title })}>查看并处理</button></article>)}
    {tasks.map((task) => <article className="semantic-card task-mini" key={task.id}><header><span className={`phase ${task.status}`}>{task.status}</span><b>{task.title}</b></header><p>{taskPresentationMessage(task)}</p><small>{task.attemptIds.length} 次尝试 · v{task.version}</small><button onClick={() => onOpenResource({ kind: "task", id: task.id, label: task.title })}>查看 Task</button></article>)}
    {sessions.map((session) => <article className="semantic-card session-mini" key={session.id}><header><span className={`phase ${session.phase}`}>{session.phase}</span><b>{state.workers[session.workerId]?.name ?? session.workerId}</b></header><p>{session.lastEvent}</p><button onClick={() => onOpenResource({ kind: "worker-session", id: session.id, label: session.summary || "Worker Session" })}>查看 Session</button></article>)}
    {recentRuns.map((run) => <article className="semantic-card run-card" key={run.id}><header><span className={`phase ${run.phase}`}>{run.phase}</span><b>{state.flows[run.flowId]?.name ?? run.flowId}</b></header><p>{flowRunPresentationMessage(run.message, `${run.completedStepIds.length} steps completed`)}</p><small>{run.completedStepIds.length}/{state.flows[run.flowId]?.steps.length ?? 0} steps · {clock(run.updatedAt)}</small><div className="inline-actions"><button onClick={() => onOpenResource({ kind: "run", id: run.id, label: state.flows[run.flowId]?.name ?? run.id })}>查看运行</button></div></article>)}
    {openPermissions.map((request) => <article className="semantic-card permission-card" key={request.id}><header><RiskBadge risk="red"/><b>需要额外权限</b></header><p>{request.reason}</p><div className="inline-actions"><button onClick={() => void postJson(`/api/permission-requests/${encodeURIComponent(request.id)}/approve`, { actorId: "human:owner" }).catch((cause) => onError(friendlyError(cause)))}>批准租约</button></div></article>)}
    {openTasks.map((task) => <article className="semantic-card human-inline" key={task.id}><header><span className={`phase ${task.phase}`}>{task.phase}</span><b>需要人的参与</b></header><p>{task.instructions}</p><div className="inline-actions"><button onClick={() => void handleHumanTask(task)}>{task.phase === "open" ? "领取并查看结果" : "批准并继续"}</button><button onClick={() => onOpenResource({ kind: "run", id: task.flowRunId, label: "Human task" })}>查看运行</button></div></article>)}
  </div></div>;
}

function ConversationBlockCard({ state, block, busy, onAct, onOpenResource, onAskSteward, onTrigger, onError }: { state: Projection; block: ConversationBlock; busy: boolean; onAct: (action: string, id: string) => void; onOpenResource: (resource: ResourceReference) => void; onAskSteward: (text: string) => void; onTrigger: (flowId: string) => void; onError: (value: string) => void }) {
  const proposal = block.proposalId ? state.productionProposals[block.proposalId] : undefined;
  const changeSet = block.changeSetId ? state.changeSets[block.changeSetId] : undefined;
  async function changeSetAction(action: "approve" | "reject") { if (!changeSet) return; try { await postJson(`/api/change-sets/${encodeURIComponent(changeSet.id)}/${action}`, { actorId: "human:owner" }); if (action === "approve") await postJson(`/api/change-sets/${encodeURIComponent(changeSet.id)}/apply`, {}); } catch (cause) { onError(friendlyError(cause)); } }
  if (proposal) return <article className={`semantic-card proposal-card ${proposal.status}`}><header><span className={`phase ${proposal.status}`}>{proposal.status}</span><div><small>PRODUCTION PLAN</small><h3>{proposal.plan.title}</h3></div></header><p>{block.text}</p><div className="plan-summary"><span><b>{triggerLabel(proposal.plan.trigger)}</b><small>TRIGGER</small></span><span><b>{proposal.plan.actors.length}</b><small>ACTORS</small></span><span><b>{proposal.plan.steps.length}</b><small>STEPS</small></span><span><b>{proposal.plan.permissionCeiling.length}</b><small>CAPABILITIES</small></span></div><div className="plan-pipeline">{proposal.plan.steps.map((step, index) => <React.Fragment key={step.id}><span><b>{step.name}</b><small>{proposal.plan.actors.find((actor) => actor.id === step.actorId)?.name ?? step.actorId}</small></span>{index < proposal.plan.steps.length - 1 && <i>→</i>}</React.Fragment>)}</div><details><summary>查看完整计划、权限与预算</summary><p>{proposal.plan.summary}</p><h4>验收条件</h4><ul>{proposal.plan.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul><h4>权限上限</h4><code>{proposal.plan.permissionCeiling.join(" · ") || "none"}</code><h4>预算</h4><code>{Math.round(proposal.plan.budget.maxRuntimeMs / 60000)} min · {proposal.plan.budget.maxTotalAttempts} attempts{proposal.plan.budget.maxCostUsd ? ` · $${proposal.plan.budget.maxCostUsd}` : ""}</code></details>{proposal.status === "ready" && <div className="inline-actions"><button disabled={busy} onClick={() => onAct("approve_proposal", proposal.id)}>批准并部署</button><button disabled={busy} onClick={() => onAct("reject_proposal", proposal.id)}>拒绝</button></div>}{proposal.status === "approved" && <div className="inline-actions"><button onClick={() => onTrigger(proposal.compiledFlowId)}>立即运行</button><button onClick={() => onOpenResource({ kind: "flow", id: proposal.compiledFlowId, label: proposal.plan.title })}>查看 Flow</button></div>}{proposal.status === "failed" && <div className="recovery-inline"><b>部署没有完成</b><p>方案已保留。把你希望调整的内容告诉 Steward，它会继续修复。</p></div>}</article>;
  if (changeSet) return <article className={`semantic-card changeset-card ${changeSet.status}`}><header><RiskBadge risk={changeSet.aggregateRisk}/><div><small>CHANGESET · {changeSet.status}</small><h3>{changeSet.title}</h3></div></header><SafeMarkdown content={block.text}/><div className="plan-summary"><span><b>{changeSet.operations.length}</b><small>CHANGES</small></span><span><b>{changeSet.impact.resourcesCreated.length}</b><small>CREATE</small></span><span><b>{changeSet.impact.resourcesModified.length}</b><small>UPDATE</small></span><span><b>{changeSet.impact.permissionsAdded.length}</b><small>PERMISSIONS</small></span></div><div className="changeset-operations">{changeSet.operations.slice(0, 4).map((operation) => <p key={operation.id}><b>{operation.kind}</b><span>{operation.targetId ?? "新资源"}</span></p>)}</div>{isRecoverableChangeSetStatus(changeSet.status) && <FailedChangeSetRecoveryAction changeSetId={changeSet.id} title={changeSet.title} status={changeSet.status} onAskSteward={onAskSteward}/>}<div className="inline-actions">{changeSet.status === "awaiting-approval" && <><button disabled={busy} onClick={() => void changeSetAction("approve")}>批准并应用</button><button disabled={busy} onClick={() => void changeSetAction("reject")}>拒绝</button></>}<button onClick={() => onOpenResource({ kind: "changeset", id: changeSet.id, label: changeSet.title })}>查看影响与恢复</button></div></article>;
  if (block.resource) return <article className="semantic-card resource-card"><header><span>RESOURCE</span><b>{block.resource.label}</b></header><SafeMarkdown content={block.text}/><button onClick={() => onOpenResource(block.resource!)}>在上下文抽屉中打开 →</button></article>;
  return <div className={`chat agent semantic-${block.kind}`}><span>STEWARD · {block.kind}</span>{block.title && <h4>{block.title}</h4>}<SafeMarkdown content={block.text}/>{block.diagnostics && <details><summary>恢复建议</summary>{block.diagnostics.map((item) => <p key={`${item.code}:${item.path}`}>{item.message}</p>)}</details>}</div>;
}

function ResourceInspector({ state, resource, onNavigate, onAskSteward, onError }: { state: Projection; resource: ResourceReference; onNavigate: (surface: Surface) => void; onAskSteward: (text: string) => void; onError: (value: string) => void }) {
  const [preview, setPreview] = useState<Preview>();
  useEffect(() => { setPreview(undefined); if (resource.kind !== "file" || !resource.path) return; void getJson<Preview>(`/api/files/preview?workspaceId=${encodeURIComponent(resource.workspaceId ?? "repository")}&path=${encodeURIComponent(resource.path)}`).then(setPreview).catch((cause) => onError(friendlyError(cause))); }, [resource, onError]);
  const flow = resource.kind === "flow" ? state.flows[resource.id] : undefined;
  const run = resource.kind === "run" || resource.kind === "flow-run" ? state.flowRuns[resource.id] : undefined;
  const agent = resource.kind === "agent" ? state.agents[resource.id] : undefined;
  const worker = resource.kind === "worker" ? state.workers[resource.id] : undefined;
  const workerSpec = resource.kind === "worker-spec" ? state.workerSpecs[resource.id] : undefined;
  const task = resource.kind === "task" ? state.tasks[resource.id] : undefined;
  const session = resource.kind === "worker-session" ? state.workerSessions[resource.id] : undefined;
  const changeSet = resource.kind === "changeset" ? state.changeSets[resource.id] : undefined;
  const surface: Surface = resource.kind === "file" ? "files" : resource.kind === "flow" || resource.kind === "run" || resource.kind === "flow-run" ? "flows" : resource.kind === "agent" || resource.kind === "worker" || resource.kind === "worker-spec" ? "workers" : resource.kind === "history" ? "history" : "graph";
  async function taskAction(action: string) { if (!task) return; try { await postJson(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, { actorId: "human:owner", expectedVersion: task.version }); } catch (cause) { onError(friendlyError(cause)); } }
  async function changeSetAction(action: "approve" | "reject") { if (!changeSet) return; try { await postJson(`/api/change-sets/${encodeURIComponent(changeSet.id)}/${action}`, { actorId: "human:owner" }); if (action === "approve") await postJson(`/api/change-sets/${encodeURIComponent(changeSet.id)}/apply`, {}); } catch (cause) { onError(friendlyError(cause)); } }
  return <div className="resource-inspector"><header><div><span>{resource.kind.toUpperCase()}</span><h3>{resource.label}</h3></div></header><code>{resource.id}</code>
    {preview && <div className="drawer-preview">{preview.kind === "markdown" ? <MarkdownPreview content={preview.content}/> : <pre>{preview.content}</pre>}</div>}
    {flow && <><Info label="STATUS" value={`${flow.status} · v${flow.version}`}/><Info label="TRIGGER" value={triggerLabel(flow.trigger)}/><Info label="STEPS" value={String(flow.steps.length)}/><div className="drawer-list">{flow.steps.map((step) => <p key={step.id}><b>{step.name}</b><small>{agentName(state, step.actorId)}</small></p>)}</div></>}
    {run && <><Info label="PHASE" value={run.phase}/><Info label="PROGRESS" value={`${run.completedStepIds.length}/${state.flows[run.flowId]?.steps.length ?? 0}`}/><p>{flowRunPresentationMessage(run.message, "等待运行状态更新")}</p></>}
    {agent && <><Info label="RUNTIME" value={agent.adapterKind}/><Info label="STATUS" value={agent.status}/><Info label="SOURCE" value={agent.source}/><p>{agent.capabilities.join(" · ")}</p></>}
    {worker && <><Info label="TYPE" value={worker.source === "adopted" ? "Adopted Worker" : "Native Worker"}/><Info label="RUNTIME" value={worker.adapterKind}/><Info label="STATUS" value={worker.status}/><Info label="DEFAULT SPEC" value={worker.defaultSpecVersionId ?? "none"}/><p>{worker.capabilities.join(" · ")}</p></>}
    {workerSpec && <><Info label="VERSION" value={`v${workerSpec.version}`}/><Info label="LIFECYCLE" value={workerSpec.lifecycle}/><p className="drawer-long-copy">{workerSpec.systemPrompt}</p><details><summary>查看完整 Harness</summary><pre>{JSON.stringify(workerSpec, null, 2)}</pre></details></>}
    {task && <><Info label="STATUS" value={task.status}/><Info label="OWNER" value={task.ownerActorId}/><Info label="ATTEMPTS" value={String(task.attemptIds.length)}/><p>{taskPresentationMessage({ description: task.description })}</p><h4>验收条件</h4><ul>{task.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul>{task.resultSummary && <p>{taskPresentationMessage(task)}</p>}<div className="inline-actions">{task.status === "running" && <button onClick={() => void taskAction("pause")}>暂停</button>}{task.status === "paused" && <button onClick={() => void taskAction("resume")}>恢复</button>}{["ready", "running", "paused", "blocked", "awaiting-acceptance"].includes(task.status) && <button onClick={() => void taskAction("cancel")}>取消</button>}{task.status === "awaiting-acceptance" && <button onClick={() => void taskAction("accept")}>验收</button>}</div></>}
    {session && <><Info label="PHASE" value={session.phase}/><Info label="WORKER" value={state.workers[session.workerId]?.name ?? session.workerId}/><Info label="SPEC" value={session.workerSpecVersionId ?? "legacy"}/><Info label="WORKSPACE" value={session.workspaceId ?? "unknown"}/>{session.taskId && <Info label="TASK" value={state.tasks[session.taskId]?.title ?? session.taskId}/>}<p>{session.summary || session.lastEvent}</p>{["starting", "running", "blocked"].includes(session.phase) && <button onClick={() => void postJson(`/api/worker-sessions/${encodeURIComponent(session.id)}/cancel`, {}).catch((cause) => onError(friendlyError(cause)))}>取消 Session</button>}</>}
    {changeSet && <><RiskBadge risk={changeSet.aggregateRisk}/><Info label="STATUS" value={changeSet.status}/><Info label="OPERATIONS" value={String(changeSet.operations.length)}/><p>{changeSet.intentSummary}</p><div className="drawer-list">{changeSet.operations.map((operation) => <p key={operation.id}><b>{operation.kind}</b><small>{operation.targetId ?? "new resource"} · {changeSet.status === "rejected" ? "not applied" : changeSet.operationResults.find((item) => item.operationId === operation.id)?.status ?? "pending"}</small></p>)}</div>{changeSet.impact.runtimeEffects.map((item) => <p key={item}>{item}</p>)}{changeSet.status === "awaiting-approval" && <div className="inline-actions"><button onClick={() => void changeSetAction("approve")}>批准并应用</button><button onClick={() => void changeSetAction("reject")}>拒绝</button></div>}{isRecoverableChangeSetStatus(changeSet.status) && <FailedChangeSetRecoveryAction changeSetId={changeSet.id} title={changeSet.title} status={changeSet.status} onAskSteward={onAskSteward}/>}</>}
    <button className="drawer-primary" onClick={() => onNavigate(surface)}>打开完整视图 →</button>
  </div>;
}

function HumanTaskCard({ state, task, actorId, onError }: { state: Projection; task: HumanTask; actorId: string; onError: (value: string) => void }) {
  const [summary, setSummary] = useState("已审阅上游成果，同意继续执行。");
  const [output, setOutput] = useState('{"decision":"go","notes":"human reviewed"}');
  const [filePath, setFilePath] = useState("");
  const [reassignTo, setReassignTo] = useState(task.assignedActorId);
  const dependencies = task.dependencyResultIds.map((id) => state.stepResults[id]).filter((item): item is StepResult => Boolean(item));
  async function action(name: "claim" | "release") { try { await postJson(`/api/human-tasks/${encodeURIComponent(task.id)}/${name}`, { actorId }); } catch (cause) { onError(message(cause)); } }
  async function complete() { try { let parsed: unknown = {}; try { parsed = output.trim() ? JSON.parse(output) as unknown : {}; } catch { throw new Error("Human output 必须是有效 JSON"); } await postJson(`/api/human-tasks/${encodeURIComponent(task.id)}/complete`, { actorId, summary, output: parsed, files: filePath.trim() ? [{ workspaceId: "repository", path: filePath.trim() }] : [] }); } catch (cause) { onError(message(cause)); } }
  async function fail() { try { await postJson(`/api/human-tasks/${encodeURIComponent(task.id)}/fail`, { actorId, reason: summary || "Human task failed" }); } catch (cause) { onError(message(cause)); } }
  async function reassign() { try { await postJson(`/api/human-tasks/${encodeURIComponent(task.id)}/reassign`, { actorId, assignedActorId: reassignTo }); } catch (cause) { onError(message(cause)); } }
  const humans = state.graph.nodes.filter((node) => node.type === "actor" && node.kind === "human");
  return <article className="attention-card human-task-card"><span className={`phase ${task.phase}`}>{task.phase}</span><h4>{humanTaskPresentationTitle({ task, stepRuns: state.stepRuns, flowRuns: state.flowRuns, flows: state.flows })}</h4><p>{task.instructions}</p><small>{task.id} · {dependencies.length} 项上游结果</small>{dependencies.length > 0 && <details><summary>查看上游成果</summary>{dependencies.map((result) => <div className="dependency-result" key={result.id}><b>{agentName(state, result.producerActorId)}</b><p>{result.summary}</p><pre>{JSON.stringify(result.output, null, 2)}</pre></div>)}</details>}{task.phase === "open" && <HumanTaskOpenActions humans={humans} value={reassignTo} onChange={setReassignTo} onClaim={() => void action("claim")} onReassign={() => void reassign()}/>} {task.phase === "claimed" && <div className="human-submit"><textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={2}/><textarea className="mono" value={output} onChange={(event) => setOutput(event.target.value)} rows={3}/><input value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="可选：仓库内文件路径"/><div className="inline-actions"><button onClick={() => void complete()}>提交并继续</button><button onClick={() => void action("release")}>释放</button><button onClick={() => void fail()}>标记失败</button></div></div>}</article>;
}

function RunDetail({ state, run, onError }: { state: Projection; run: FlowRun; onError: (value: string) => void }) {
  const flow = state.flows[run.flowId];
  const order = new Map(flow?.steps.map((step, index) => [step.id, index]) ?? []);
  const stepRuns = Object.values(state.stepRuns).filter((item) => item.flowRunId === run.id).sort((a, b) => (order.get(a.stepId) ?? 0) - (order.get(b.stepId) ?? 0));
  const leases = Object.values(state.permissionLeases).filter((item) => item.flowRunId === run.id);
  async function runAction(action: "resume" | "cancel") { try { await postJson(`/api/flow-runs/${encodeURIComponent(run.id)}/${action}`, {}); } catch (cause) { onError(message(cause)); } }
  return <section className="run-detail"><header><div><span className="eyebrow">FLOW RUN · v{run.flowVersion}</span><h2>{flow?.name ?? run.flowId}</h2><code>{run.id}</code></div><div className="run-actions"><span className={`phase ${run.phase}`}>{run.phase}</span>{run.phase === "blocked" && <button onClick={() => void runAction("resume")}>恢复扫描</button>}{["queued", "running", "blocked"].includes(run.phase) && <button onClick={() => void runAction("cancel")}>取消 Run</button>}</div></header><div className="run-metrics"><Info label="ATTEMPTS" value={String(run.totalAttempts ?? 0)}/><Info label="COMPLETED" value={`${run.completedStepIds.length}/${flow?.steps.length ?? stepRuns.length}`}/><Info label="LEASES" value={String(leases.length)}/><Info label="UPDATED" value={clock(run.updatedAt)}/></div><p className="run-message">{flowRunPresentationMessage(run.message, "等待运行状态更新")}</p><div className="run-steps">{stepRuns.map((stepRun) => <StepRunCard key={stepRun.id} state={state} stepRun={stepRun} onError={onError}/>)}</div></section>;
}

function StepRunCard({ state, stepRun, onError }: { state: Projection; stepRun: StepRun; onError: (value: string) => void }) {
  const run = state.flowRuns[stepRun.flowRunId]; const flow = run ? state.flows[run.flowId] : undefined; const step = flow?.steps.find((item) => item.id === stepRun.stepId);
  const attempts = Object.values(state.stepAttempts).filter((item) => item.stepRunId === stepRun.id).sort((a, b) => a.ordinal - b.ordinal);
  const result = stepRun.resultId ? state.stepResults[stepRun.resultId] : undefined;
  async function retry() { try { await postJson(`/api/step-runs/${encodeURIComponent(stepRun.id)}/retry`, {}); } catch (cause) { onError(friendlyError(cause)); } }
  async function replace(actorId: string) { try { await postJson(`/api/step-runs/${encodeURIComponent(stepRun.id)}/replace-actor`, { actorId }); } catch (cause) { onError(friendlyError(cause)); } }
  const presentationMessage = stepRunPresentationMessage({ phase: stepRun.phase, message: stepRun.message, stepKind: step?.kind, actorName: agentName(state, stepRun.actorId) });
  return <article className={`run-step ${stepRun.phase}`}><header><span className={`phase ${stepRun.phase}`}>{stepRun.phase}</span><b>{step?.name ?? stepRun.stepId}</b><small>{step?.join?.mode ?? "all"} · {agentName(state, stepRun.actorId)}</small></header><p>{presentationMessage}</p><div className="step-meta"><span>{attempts.length} 次尝试</span><span>{step?.dependsOn.length ? `依赖 ${step.dependsOn.join(", ")}` : "起始步骤"}</span></div>{attempts.length > 0 && <details><summary>查看尝试与权限</summary>{attempts.map((attempt) => <p key={attempt.id} className="mono">#{attempt.ordinal} {attempt.phase} · {attempt.agentSessionId ?? attempt.humanTaskId ?? attempt.id} · {attempt.permissionLeaseId}</p>)}</details>}{result && <details open><summary>最终结果</summary>{result.status === "failed" ? <p>{stepRunPresentationMessage({ phase: "failed", message: result.summary, stepKind: step?.kind, actorName: agentName(state, stepRun.actorId) })}</p> : <><p>{result.summary}</p><pre>{JSON.stringify(result.output, null, 2)}</pre>{result.artifacts.map((artifact) => <p className="artifact-ref" key={artifact.artifactId}>{artifact.summary} · {artifact.mediaType} · {artifact.sha256.slice(0, 10)}</p>)}</>}</details>}{["failed", "blocked"].includes(stepRun.phase) && step?.kind === "agent" && <WorkerStepRecoveryActions agents={Object.values(state.agents)} currentActorId={stepRun.actorId} onRetry={() => void retry()} onReplace={(actorId) => void replace(actorId)}/>}</article>;
}

function StepRunInspector({ state, stepRun }: { state: Projection; stepRun: StepRun }) {
  const attempts = Object.values(state.stepAttempts).filter((item) => item.stepRunId === stepRun.id);
  const result = stepRun.resultId ? state.stepResults[stepRun.resultId] : undefined;
  const run = state.flowRuns[stepRun.flowRunId];
  const step = run ? state.flows[run.flowId]?.steps.find((item) => item.id === stepRun.stepId) : undefined;
  const resultMessage = result ? stepRunPresentationMessage({ phase: result.status, message: result.summary, stepKind: step?.kind, actorName: agentName(state, stepRun.actorId) }) : undefined;
  return <><Info label="ACTOR" value={agentName(state, stepRun.actorId)}/><Info label="ATTEMPTS" value={String(attempts.length)}/><Info label="UPSTREAM" value={stepRun.selectedDependencyStepRunIds.join(", ") || "root"}/>{result && <div className="inspector-result"><span>RESULT</span><p>{resultMessage}</p>{result.status !== "failed" && <pre>{JSON.stringify(result.output, null, 2)}</pre>}</div>}</>;
}

function Page({ eyebrow, title, subtitle, children }: React.PropsWithChildren<{ eyebrow: string; title: string; subtitle: string }>) { return <section className="page"><header className="page-header"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></header>{children}</section> }
function NavItem({ surface, current, onSelect, count }: { surface: Surface; current: Surface; onSelect: (value: Surface) => void; count?: number }) { return <button className={`nav-item ${surface === current ? "active" : ""}`} onClick={() => onSelect(surface)}><span>{({ now: "Now", graph: "Graph", workers: "Workers", flows: "Flows", files: "Files", history: "History", steward: "Steward" } as Record<Surface, string>)[surface]}</span>{count !== undefined && count > 0 && <b>{count}</b>}</button> }
function Info({ label, value }: { label: string; value: string }) { return <div className="info"><span>{label}</span><b>{value}</b></div> }
function NowColumn({ title, count, children }: React.PropsWithChildren<{ title: string; count: number }>) { return <section className="now-column"><header><h3>{title}</h3><b>{String(count).padStart(2, "0")}</b></header><div>{children}{count === 0 && <p className="column-empty">当前没有项目</p>}</div></section> }
function SignalCard({ title, meta, text }: { title: string; meta: string; text: string }) { return <article className="attention-card"><h4>{title}</h4><small>{meta}</small><p>{text}</p></article> }
function RiskBadge({ risk }: { risk: Risk }) { return <span className={`risk ${risk}`}>{risk.toUpperCase()}</span> }
function SpecSummary({ spec }: { spec: AgentSpec | undefined }) { if (!spec) return null; return <div className="spec-summary"><span className="eyebrow">GRAPH HARNESS · v{spec.version}</span><p>{spec.prompt}</p><small>{spec.engine} · {spec.skills.length} skills · {spec.tools.length} tools · delegation {spec.canOrchestrate ? `${spec.maxDelegationDepth}/${spec.maxFanOut}` : "disabled"}</small></div> }
function Empty({ text }: { text: string }) { return <div className="empty"><span>∴</span><p>{text}</p></div> }
function MarkdownPreview({ content }: { content: string }) { return <SafeMarkdown content={content} className="markdown-preview markdown-content"/> }
function agentName(state: Projection, id: string) { return state.agents[id]?.name ?? state.graph.nodes.find((node) => node.id === id)?.name ?? id }
function clock(value: string) { return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }
function formatDuration(value: number) { return value < 60_000 ? `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒` : `${Math.floor(value / 60_000)} 分 ${Math.round((value % 60_000) / 1_000)} 秒` }
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function fileIcon(name: string) { const extension = name.split(".").pop()?.toLowerCase(); return extension === "md" ? "M" : extension === "json" ? "{}" : ["ts", "tsx", "js", "jsx"].includes(extension ?? "") ? "<>" : "·" }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }
function normalizeProjection(value: Projection): Projection { return { ...emptyState, ...value, stewardResponses: value.stewardResponses ?? [], agents: value.agents ?? {}, agentSpecs: value.agentSpecs ?? {}, agentSessions: value.agentSessions ?? {}, workers: value.workers ?? {}, workerSpecs: value.workerSpecs ?? {}, workerSessions: value.workerSessions ?? {}, tasks: value.tasks ?? {}, taskAttempts: value.taskAttempts ?? {}, changeSets: value.changeSets ?? {}, flows: value.flows ?? {}, flowRuns: value.flowRuns ?? {}, stepRuns: value.stepRuns ?? {}, stepAttempts: value.stepAttempts ?? {}, stepResults: value.stepResults ?? {}, humanTasks: value.humanTasks ?? {}, permissionLeases: value.permissionLeases ?? {}, permissionRequests: value.permissionRequests ?? {}, attention: value.attention ?? {}, conversationBlocks: value.conversationBlocks ?? [], designSessions: value.designSessions ?? {}, productionProposals: value.productionProposals ?? {} } }
async function getJson<T>(url: string): Promise<T> { const response = await fetch(url); return responseJson<T>(response) }
async function postJson<T = unknown>(url: string, body: unknown): Promise<T> { const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return responseJson<T>(response) }
async function responseJson<T>(response: Response): Promise<T> { const json = await response.json() as T & { message?: string; error?: string }; if (!response.ok) throw new Error(json.message ?? json.error ?? `HTTP ${response.status}`); return json }
function friendlyError(error: unknown) { const raw = message(error); if (/configured_by|edge|invariant|zod|parse|projection/i.test(raw)) return "Steward 检查到方案结构不完整，已停止部署。请在对话中补充目标或让 Steward 调整方案。"; if (/timeout|timed out/i.test(raw)) return "Steward 这次思考超时了。你的消息已经保留，可以直接重试。"; return "请求未能完成。现有生产图没有被破坏，你可以重试或让 Steward 调整方案。" }
function triggerLabel(trigger: { kind: string; intervalMs?: number; timeOfDay?: string; timezone?: string }) { if (trigger.kind !== "schedule") return trigger.kind; return trigger.timeOfDay ? `${trigger.timeOfDay} ${trigger.timezone ?? ""}`.trim() : trigger.intervalMs ? `每 ${Math.round(trigger.intervalMs / 3600000)} 小时` : "schedule" }

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
