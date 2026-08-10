import type {
  GraphProjectionInput,
  LivingGraphViewModel,
  SourceFlow,
  SourceFlowRun,
  VisualEdge,
  VisualKind,
  VisualNode,
} from "./graph-model.js";

const expandedRunPhases = new Set(["queued", "running", "blocked"]);

export function buildLivingGraph(input: GraphProjectionInput, expandedStacks: ReadonlySet<string> = new Set()): LivingGraphViewModel {
  const nodes = new Map<string, VisualNode>();
  const edges = new Map<string, VisualEdge>();
  const diagnostics: LivingGraphViewModel["diagnostics"] = [];
  const aliases = new Map<string, string>();

  const addNode = (node: VisualNode) => nodes.set(node.id, { ...nodes.get(node.id), ...node });
  const addEdge = (edge: VisualEdge) => edges.set(edge.id, edge);

  for (const node of input.graph.nodes) {
    const visualId = canonicalSourceId(node.id, node.type, node.kind, input);
    aliases.set(node.id, visualId);
    addNode({
      id: visualId,
      sourceId: node.id,
      label: node.name ?? node.id,
      kind: sourceNodeKind(node.type, node.kind),
      status: node.status ?? "active",
      meta: node.kind ?? node.type,
    });
  }
  for (const edge of input.graph.edges) addEdge({ ...edge, from: aliases.get(edge.from) ?? edge.from, to: aliases.get(edge.to) ?? edge.to });

  const flows = Object.values(input.flows).sort(byId);
  for (const flow of flows) addFlow(flow, input, nodes, addNode, addEdge, expandedStacks, diagnostics);

  for (const result of Object.values(input.stepResults)) {
    const stepRun = input.stepRuns[result.stepRunId];
    if (!stepRun || !nodes.has(stepRun.id)) continue;
    for (const artifact of result.artifacts) {
      const artifactId = artifact.artifactId;
      addNode({ id: artifactId, sourceId: artifactId, label: artifact.summary || artifactId, kind: "artifact", status: "available", meta: artifact.uri });
      addEdge({ id: `produces:${stepRun.id}:${artifactId}`, type: "produces", from: stepRun.id, to: artifactId, status: stepRun.phase });
    }
  }

  for (const lease of Object.values(input.permissionLeases)) {
    for (const capability of lease.capabilities) {
      const capabilityId = ensureCapability(nodes, capability, addNode);
      if (nodes.has(lease.actorId)) addEdge({ id: `lease:${lease.id}:${capabilityId}`, type: "authorization", from: lease.actorId, to: capabilityId, status: lease.status });
      if (nodes.has(lease.flowRunId)) addEdge({ id: `lease-scope:${lease.id}:${capabilityId}`, type: "scoped_to", from: capabilityId, to: lease.flowRunId, status: lease.status });
    }
  }

  const validEdges = new Map<string, VisualEdge>();
  for (const edge of edges.values()) {
    if (!nodes.has(edge.from)) diagnostics.push({ code: "MISSING_EDGE_SOURCE", entityId: edge.id, message: `Missing source ${edge.from}` });
    else if (!nodes.has(edge.to)) diagnostics.push({ code: "MISSING_EDGE_TARGET", entityId: edge.id, message: `Missing target ${edge.to}` });
    else {
      const signature = `${edge.type}|${edge.from}|${edge.to}|${edge.role ?? ""}`;
      const existing = validEdges.get(signature);
      if (!existing || edge.status) validEdges.set(signature, edge);
    }
  }

  return { nodes: [...nodes.values()], edges: [...validEdges.values()], diagnostics };
}

function addFlow(
  flow: SourceFlow,
  input: GraphProjectionInput,
  nodes: Map<string, VisualNode>,
  addNode: (node: VisualNode) => void,
  addEdge: (edge: VisualEdge) => void,
  expandedStacks: ReadonlySet<string>,
  diagnostics: LivingGraphViewModel["diagnostics"],
) {
  addNode({ id: flow.id, sourceId: flow.id, label: flow.name, kind: "flow", status: flow.status, meta: `Flow v${flow.version}` });

  const flowStepIds = new Map<string, string>();
  for (const step of flow.steps) {
    const visualId = `flow-step:${flow.id}:${step.id}`;
    flowStepIds.set(step.id, visualId);
    addNode({ id: visualId, sourceId: step.id, label: step.name, kind: "step", status: flow.status, parentId: flow.id, actorId: step.actorId, meta: "FLOW STEP" });
    addEdge({ id: `contains:${flow.id}:${visualId}`, type: "contains", from: flow.id, to: visualId });
    if (nodes.has(step.actorId)) addEdge({ id: `assignment:${step.actorId}:${visualId}`, type: "assignment", from: step.actorId, to: visualId, role: "executor" });
    for (const capability of step.requiredCapabilities ?? []) {
      const capabilityId = ensureCapability(nodes, capability, addNode);
      if (nodes.has(step.actorId)) addEdge({ id: `requires:${step.actorId}:${visualId}:${capabilityId}`, type: "authorization", from: step.actorId, to: capabilityId });
    }
  }
  for (const step of flow.steps) {
    const to = flowStepIds.get(step.id)!;
    for (const dependency of step.dependsOn) {
      const from = flowStepIds.get(dependency);
      if (from) addEdge({ id: `depends:${flow.id}:${dependency}:${step.id}`, type: "depends_on", from, to });
    }
  }
  for (const capability of flow.permissionCeiling) {
    const capabilityId = ensureCapability(nodes, capability, addNode);
    addEdge({ id: `ceiling:${flow.id}:${capabilityId}`, type: "permission_ceiling", from: capabilityId, to: flow.id });
  }

  const runs = Object.values(input.flowRuns).filter((run) => run.flowId === flow.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const latestFailed = runs.find((run) => run.phase === "failed");
  const blocked = runs.filter((run) => run.phase === "blocked");
  const otherAttentionRuns = runs.filter((run) => run.phase !== "blocked" && (expandedRunPhases.has(run.phase) || run.id === latestFailed?.id)).slice(0, 3);
  const expanded = [...blocked, ...otherAttentionRuns];
  const historical = runs.filter((run) => !expanded.some((candidate) => candidate.id === run.id));
  if (expandedStacks.has(flow.id)) expanded.push(...historical.slice(0, 3));

  for (const run of uniqueRuns(expanded)) addRun(run, flow, input, nodes, addNode, addEdge, diagnostics);
  if (historical.length > 0) {
    const failed = historical.filter((run) => run.phase === "failed").length;
    addNode({ id: `run-stack:${flow.id}`, label: `${historical.length} historical runs`, kind: "run-stack", status: failed ? "failed" : "completed", parentId: flow.id, sourceId: flow.id, meta: failed ? `${failed} failed · ${historical.length - failed} completed` : "completed history" });
    addEdge({ id: `contains:${flow.id}:run-stack`, type: "contains", from: flow.id, to: `run-stack:${flow.id}` });
  }
}

function addRun(
  run: SourceFlowRun,
  flow: SourceFlow,
  input: GraphProjectionInput,
  nodes: Map<string, VisualNode>,
  addNode: (node: VisualNode) => void,
  addEdge: (edge: VisualEdge) => void,
  diagnostics: LivingGraphViewModel["diagnostics"],
) {
  addNode({ id: run.id, sourceId: run.id, label: `${flow.name} · ${shortId(run.id)}`, kind: "run", status: run.phase, parentId: flow.id, meta: `${run.completedStepIds.length}/${flow.steps.length} steps` });
  addEdge({ id: `contains:${flow.id}:${run.id}`, type: "contains", from: flow.id, to: run.id, status: run.phase });

  const stepRuns = Object.values(input.stepRuns).filter((stepRun) => stepRun.flowRunId === run.id);
  if (stepRuns.length === 0 && flow.steps.length > 0) diagnostics.push({ code: "INCOMPLETE_RUN", entityId: run.id, message: `Run ${run.id} has no projected step runs` });
  const byStepId = new Map(stepRuns.map((stepRun) => [stepRun.stepId, stepRun]));
  for (const stepRun of stepRuns) {
    const step = flow.steps.find((candidate) => candidate.id === stepRun.stepId);
    addNode({ id: stepRun.id, sourceId: stepRun.id, label: step?.name ?? stepRun.stepId, kind: "step", status: stepRun.phase, parentId: run.id, actorId: stepRun.actorId, meta: "RUN STEP" });
    addEdge({ id: `contains:${run.id}:${stepRun.id}`, type: "contains", from: run.id, to: stepRun.id, status: stepRun.phase });
    if (nodes.has(stepRun.actorId)) addEdge({ id: `assignment:${stepRun.actorId}:${stepRun.id}`, type: "assignment", from: stepRun.actorId, to: stepRun.id, role: "executor", status: stepRun.phase });
  }
  for (const step of flow.steps) {
    const to = byStepId.get(step.id);
    if (!to) continue;
    for (const dependency of step.dependsOn) {
      const from = byStepId.get(dependency);
      if (from) addEdge({ id: `run-depends:${run.id}:${from.id}:${to.id}`, type: "depends_on", from: from.id, to: to.id, status: to.phase });
    }
  }
}

function ensureCapability(nodes: Map<string, VisualNode>, capability: string, addNode: (node: VisualNode) => void): string {
  const existing = [...nodes.values()].find((node) => node.kind === "capability" && (node.id === capability || node.meta === capability || node.label === capability));
  if (existing) return existing.id;
  const id = `capability:${capability}`;
  addNode({ id, sourceId: id, label: capabilityLabel(capability), kind: "capability", status: "active", meta: capability });
  return id;
}

function sourceNodeKind(type: string, kind?: string): VisualKind {
  if (type === "actor" || type === "artifact" || type === "capability") return type;
  if (kind === "flow" || kind === "step" || kind === "run") return kind;
  return "work";
}

function uniqueRuns(runs: SourceFlowRun[]): SourceFlowRun[] {
  return [...new Map(runs.map((run) => [run.id, run])).values()];
}

function byId<T extends { id: string }>(a: T, b: T): number { return a.id.localeCompare(b.id); }
function shortId(id: string): string { return id.length > 14 ? id.slice(-8) : id; }
function capabilityLabel(value: string): string { return value.replaceAll("-", " ").replace(/\b\w/g, (character) => character.toUpperCase()); }

function canonicalSourceId(id: string, type: string, kind: string | undefined, input: GraphProjectionInput): string {
  if (type !== "work") return id;
  for (const flow of Object.values(input.flows)) {
    if (kind === "flow" && id === `work:flow:${flow.id}`) return flow.id;
    const stepPrefix = `work:flow:${flow.id}:v${flow.version}:`;
    if (kind === "step" && id.startsWith(stepPrefix)) return `flow-step:${flow.id}:${id.slice(stepPrefix.length)}`;
  }
  return id;
}
