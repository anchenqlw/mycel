import React, { useEffect, useMemo, useRef, useState } from "react";
import { matchesEmphasis, oneHopNeighborhood } from "./graph-focus.js";
import { layoutLivingGraph, positionSnapshot } from "./graph-layout.js";
import type { GraphProjectionInput, GraphSelection, PositionedGraph, VisualEdge, VisualKind, VisualNode } from "./graph-model.js";
import { buildLivingGraph } from "./graph-projection.js";
import "./graph.css";

const kinds: VisualKind[] = ["actor", "flow", "run", "artifact", "capability"];
const statuses = ["running", "blocked", "failed", "completed"];

export function GraphView({ state, selected, onSelect, onInspect }: { state: GraphProjectionInput; selected: string; onSelect: (id: string) => void; onInspect: (selection?: GraphSelection) => void }) {
  const [selectedId, setSelectedId] = useState(selected);
  const [emphasizedKinds, setEmphasizedKinds] = useState<Set<string>>(new Set());
  const [emphasizedStatuses, setEmphasizedStatuses] = useState<Set<string>>(new Set());
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [followedRun, setFollowedRun] = useState("");
  const previousPositions = useRef(new Map<string, { x: number; y: number }>());
  const drag = useRef<{ clientX: number; clientY: number; x: number; y: number } | undefined>(undefined);

  const expandedKey = [...expandedStacks].sort().join("|");
  const model = useMemo(() => buildLivingGraph(state, expandedStacks), [state, expandedKey]);
  const graph = useMemo(() => layoutLivingGraph(model, previousPositions.current), [model]);
  useEffect(() => { previousPositions.current = positionSnapshot(graph); }, [graph]);
  useEffect(() => { if (selected) setSelectedId(selected); }, [selected]);

  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const neighborhood = useMemo(() => selectedId ? oneHopNeighborhood(graph, selectedId) : new Set<string>(), [graph, selectedId]);
  const normalizedQuery = query.trim().toLowerCase();

  function selectNode(node: VisualNode) {
    setSelectedId(node.id);
    onSelect(state.graph.nodes.some((candidate) => candidate.id === node.sourceId) ? node.sourceId ?? "" : "");
    onInspect(toSelection(node, graph));
  }

  function selectEdge(edge: VisualEdge) {
    setSelectedId(edge.id);
    onSelect("");
    const from = nodeById.get(edge.from); const to = nodeById.get(edge.to);
    onInspect({ id: edge.id, label: edge.type, kind: "edge", status: edge.status ?? "active", relations: [{ id: edge.id, type: edge.type, direction: "out", targetId: edge.to, targetLabel: `${from?.label ?? edge.from} → ${to?.label ?? edge.to}` }] });
  }

  function clearFocus() {
    setSelectedId("");
    onSelect("");
    onInspect(undefined);
  }

  function toggleGroup(node: VisualNode) {
    if (node.kind === "run-stack") {
      setExpandedStacks(toggleSet(expandedStacks, node.parentId ?? node.sourceId ?? ""));
      return;
    }
    if (node.kind === "flow" || node.kind === "run") setCollapsedGroups(toggleSet(collapsedGroups, node.id));
  }

  function resetView() {
    setSelectedId(""); setEmphasizedKinds(new Set()); setEmphasizedStatuses(new Set()); setCollapsedGroups(new Set()); setExpandedStacks(new Set()); setQuery(""); setViewport({ x: 0, y: 0, scale: 1 }); setFollowedRun(""); onSelect(""); onInspect(undefined);
  }

  function isVisible(node: VisualNode): boolean {
    let parentId = node.parentId;
    while (parentId) {
      if (collapsedGroups.has(parentId)) return false;
      parentId = nodeById.get(parentId)?.parentId;
    }
    return true;
  }

  function nodeOpacity(node: VisualNode): number {
    if (selectedId && !neighborhood.has(node.id)) return .18;
    if (!matchesEmphasis(node.kind, node.status, emphasizedKinds, emphasizedStatuses)) return .22;
    if (normalizedQuery && !`${node.label} ${node.meta ?? ""}`.toLowerCase().includes(normalizedQuery)) return .16;
    return 1;
  }

  function edgeOpacity(edge: VisualEdge): number {
    if (!isVisible(nodeById.get(edge.from)!) || !isVisible(nodeById.get(edge.to)!)) return 0;
    if (selectedId && edge.from !== selectedId && edge.to !== selectedId) return .08;
    return edge.type === "contains" ? .16 : .55;
  }

  function handleWheel(event: React.WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    setViewport((current) => ({ ...current, scale: clamp(current.scale * (event.deltaY > 0 ? .9 : 1.1), .45, 2.2) }));
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!drag.current) return;
    setViewport((current) => ({ ...current, x: drag.current!.x + event.clientX - drag.current!.clientX, y: drag.current!.y + event.clientY - drag.current!.clientY }));
  }

  return <section className="living-graph-page" onKeyDown={(event) => { if (event.key === "Escape") clearFocus(); }}>
    <header className="living-graph-header"><div><span className="eyebrow">协作关系图</span><h1>Graph</h1><p>点击节点查看参与者、任务、产物与权限关系；使用筛选器定位运行或阻塞项。</p></div><div className="graph-facts"><span><b>{graph.nodes.length}</b>节点</span><span><b>{graph.edges.length}</b>关系</span><span><b>{graph.diagnostics.length}</b>异常</span></div></header>
    <div className="graph-commandbar">
      <label className="graph-search"><span>⌕</span><input aria-label="搜索生产图" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Actor、Flow、Run、Artifact…"/></label>
      <div className="graph-emphasis" aria-label="类型强调">{kinds.map((kind) => <button key={kind} className={emphasizedKinds.has(kind) ? "active" : ""} onClick={() => setEmphasizedKinds(toggleSet(emphasizedKinds, kind))}>{kind === "capability" ? "permission" : kind}</button>)}</div>
      <div className="graph-emphasis status" aria-label="状态强调">{statuses.map((status) => <button key={status} className={emphasizedStatuses.has(status) ? "active" : ""} onClick={() => setEmphasizedStatuses(toggleSet(emphasizedStatuses, status))}>{status}</button>)}</div>
      <button className="graph-reset" onClick={resetView}>重置视图</button>
    </div>
    <div className="graph-stage">
      <div className="graph-zone-label actors">ORGANIZATION</div><div className="graph-zone-label production">FLOW + LIVE RUN</div><div className="graph-zone-label artifacts">ARTIFACT</div><div className="graph-zone-label permissions">CAPABILITY + PERMISSION</div>
      <svg className="graph-canvas" style={{ minWidth: graph.width, minHeight: graph.height }} aria-label="统一动态生产图" role="application" tabIndex={0} viewBox={`0 0 ${graph.width} ${graph.height}`} onWheel={handleWheel} onPointerDown={(event) => { if (event.target === event.currentTarget) { drag.current = { clientX: event.clientX, clientY: event.clientY, x: viewport.x, y: viewport.y }; clearFocus(); event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerMove={handlePointerMove} onPointerUp={() => { drag.current = undefined; if (followedRun) setFollowedRun(""); }}>
        <defs><marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z"/></marker><filter id="graph-glow"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {graph.edges.map((edge) => <GraphEdgeLine key={edge.id} edge={edge} graph={graph} opacity={edgeOpacity(edge)} selected={selectedId === edge.id} onSelect={() => selectEdge(edge)}/>) }
          {graph.nodes.filter((node) => node.kind === "flow").map((node) => isVisible(node) && <GraphGroup key={node.id} node={node} opacity={nodeOpacity(node)} selected={selectedId === node.id} collapsed={collapsedGroups.has(node.id)} onSelect={() => selectNode(node)} onToggle={() => toggleGroup(node)}/>) }
          {graph.nodes.filter((node) => node.kind === "run").map((node) => isVisible(node) && <GraphGroup key={node.id} node={node} opacity={nodeOpacity(node)} selected={selectedId === node.id} collapsed={collapsedGroups.has(node.id)} onSelect={() => selectNode(node)} onToggle={() => toggleGroup(node)}/>) }
          {graph.nodes.filter((node) => node.kind !== "flow" && node.kind !== "run").map((node) => isVisible(node) && <GraphNodeShape key={node.id} node={node} opacity={nodeOpacity(node)} selected={selectedId === node.id} onSelect={() => selectNode(node)} onToggle={() => toggleGroup(node)}/>) }
        </g>
      </svg>
      <div className="graph-viewport-tools"><button aria-label="放大生产图" onClick={() => setViewport((value) => ({ ...value, scale: clamp(value.scale * 1.15, .45, 2.2) }))}>+</button><button aria-label="缩小生产图" onClick={() => setViewport((value) => ({ ...value, scale: clamp(value.scale * .85, .45, 2.2) }))}>−</button><button aria-label="适配全图" onClick={() => setViewport({ x: 0, y: 0, scale: 1 })}>⌂</button></div>
      <button className={`follow-run ${followedRun ? "active" : ""}`} disabled={nodeById.get(selectedId)?.kind !== "run"} onClick={() => setFollowedRun(followedRun ? "" : selectedId)}>{followedRun ? "正在跟随运行" : "跟随运行"}</button>
      {graph.diagnostics.length > 0 && <div className="graph-diagnostic">已隐藏 {graph.diagnostics.length} 条不完整关系</div>}
    </div>
    <footer className="graph-legend"><span><i className="actor"/>Actor / Organization</span><span><i className="flow"/>Flow / Step</span><span><i className="run"/>Run state</span><span><i className="artifact"/>Artifact</span><span><i className="capability"/>Capability / Permission</span><small>单击聚焦 · 双击展开 · 空白恢复 · 滚轮缩放</small></footer>
  </section>;
}

function GraphGroup({ node, opacity, selected, collapsed, onSelect, onToggle }: { node: VisualNode; opacity: number; selected: boolean; collapsed: boolean; onSelect: () => void; onToggle: () => void }) {
  return <g className={`living-node graph-group ${node.kind} ${node.status} ${selected ? "selected" : ""}`} opacity={opacity}>
    <rect x={node.x} y={node.y} width={node.width} height={node.height} rx={node.kind === "flow" ? 14 : 9}/>
    <g className="group-hit" data-node-id={node.id} data-graph-kind={node.kind} onClick={(event) => { event.stopPropagation(); onSelect(); }} onDoubleClick={(event) => { event.stopPropagation(); onToggle(); }} onKeyDown={(event) => { if (event.key === "Enter") { event.stopPropagation(); onToggle(); } }} role="button" aria-label={`${node.kind} ${node.label} ${node.status}`} tabIndex={0}>
      <title>{node.label} · {node.status}</title><rect x={node.x} y={node.y} width={node.width} height={72} rx={node.kind === "flow" ? 14 : 9}/><text className="group-kicker" x={(node.x ?? 0) + 18} y={(node.y ?? 0) + 23}>{node.kind === "flow" ? "流程定义" : "当前运行"}</text><text className="group-title" x={(node.x ?? 0) + 18} y={(node.y ?? 0) + 52}>{truncateByUnits(node.label, 52)}</text><text className="group-status" x={(node.x ?? 0) + (node.width ?? 0) - 18} y={(node.y ?? 0) + 25} textAnchor="end">{node.status}{collapsed ? " · 已收起" : ""}</text>
    </g>
  </g>;
}

function GraphNodeShape({ node, opacity, selected, onSelect, onToggle }: { node: VisualNode; opacity: number; selected: boolean; onSelect: () => void; onToggle: () => void }) {
  const x = node.x ?? 0, y = node.y ?? 0, width = node.width ?? 120, height = node.height ?? 48;
  const titleLines = wrapGraphLabel(node.label, 18);
  const titleStart = titleLines.length === 1 ? y + height / 2 - 5 : y + 20;
  return <g className={`living-node node-shape ${node.kind} ${node.status} ${selected ? "selected" : ""}`} data-node-id={node.id} data-graph-kind={node.kind} data-node-status={node.status} opacity={opacity} onClick={(event) => { event.stopPropagation(); onSelect(); }} onDoubleClick={(event) => { event.stopPropagation(); onToggle(); }} role="button" aria-label={`${node.kind} ${node.label} ${node.status}`} tabIndex={0}>
    <title>{node.label} · {node.meta ?? node.status}</title>{node.kind === "artifact" ? <path d={`M${x},${y} h${width - 18} l18,18 v${height - 18} h-${width} z M${x + width - 18},${y} v18 h18`}/> : <rect x={x} y={y} width={width} height={height} rx={node.kind === "actor" ? height / 2 : node.kind === "capability" || node.kind === "run-stack" ? height / 2 : 7}/>}<circle className="status-dot" cx={x + 16} cy={y + height / 2} r="4"/><text className="node-title" x={x + 29} y={titleStart}>{titleLines.map((line, index) => <tspan key={`${line}:${index}`} x={x + 29} dy={index ? 15 : 0}>{line}</tspan>)}</text><text className="node-meta" x={x + 29} y={y + height - 9}>{truncateByUnits(node.meta ?? node.status, 24)}</text>
  </g>;
}

function GraphEdgeLine({ edge, graph, opacity, selected, onSelect }: { edge: VisualEdge; graph: PositionedGraph; opacity: number; selected: boolean; onSelect: () => void }) {
  const from = graph.nodes.find((node) => node.id === edge.from); const to = graph.nodes.find((node) => node.id === edge.to);
  if (!from || !to || !opacity) return null;
  const start = center(from); const end = center(to);
  return <line className={`living-edge edge-${edge.type} ${edge.status ?? ""} ${selected ? "selected" : ""}`} data-edge-id={edge.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} opacity={opacity} markerEnd="url(#graph-arrow)" onClick={(event) => { event.stopPropagation(); onSelect(); }}><title>{edge.type}{edge.role ? ` · ${edge.role}` : ""}</title></line>;
}

function toSelection(node: VisualNode, graph: PositionedGraph): GraphSelection {
  const nodes = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const relations = graph.edges.filter((edge) => edge.from === node.id || edge.to === node.id).map((edge) => { const outgoing = edge.from === node.id; const targetId = outgoing ? edge.to : edge.from; return { id: edge.id, type: edge.type, direction: outgoing ? "out" as const : "in" as const, targetId, targetLabel: nodes.get(targetId)?.label ?? targetId }; });
  return { id: node.id, label: node.label, kind: node.kind, status: node.status, ...(node.sourceId ? { sourceId: node.sourceId } : {}), relations };
}

function center(node: VisualNode) { return { x: (node.x ?? 0) + (node.width ?? 0) / 2, y: (node.y ?? 0) + (node.height ?? 0) / 2 }; }
function toggleSet(current: ReadonlySet<string>, value: string): Set<string> { const next = new Set(current); if (next.has(value)) next.delete(value); else if (value) next.add(value); return next; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)); }
function truncateByUnits(value: string, maximum: number): string {
  if (textUnits(value) <= maximum) return value;
  let result = "";
  for (const character of value) {
    if (textUnits(`${result}${character}…`) > maximum) break;
    result += character;
  }
  return `${result.trimEnd()}…`;
}
export function wrapGraphLabel(value: string, maximum: number): string[] {
  if (textUnits(value) <= maximum) return [value];
  const words = value.trim().split(/\s+/);
  if (words.length === 1) return [truncateByUnits(value, maximum)];
  let first = words.shift() ?? "";
  while (words.length > 0 && textUnits(`${first} ${words[0]}`) <= maximum) first = `${first} ${words.shift()}`;
  const remainder = words.join(" ");
  return remainder ? [truncateByUnits(first, maximum), truncateByUnits(remainder, maximum)] : [truncateByUnits(first, maximum)];
}
function textUnits(value: string): number { return [...value].reduce((total, character) => total + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1), 0); }
