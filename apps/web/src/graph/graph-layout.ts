import type { LivingGraphViewModel, Point, PositionedGraph, VisualNode } from "./graph-model.js";

export type PositionSnapshot = ReadonlyMap<string, Point>;

export function layoutLivingGraph(model: LivingGraphViewModel, previous: PositionSnapshot = new Map()): PositionedGraph {
  const nodes = model.nodes.map((node) => ({ ...node }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const flows = nodes.filter((node) => node.kind === "flow" && !node.parentId).sort(byNodeId);
  const actors = nodes.filter((node) => node.kind === "actor" && !node.parentId).sort(byNodeId);
  const artifacts = nodes.filter((node) => node.kind === "artifact" && !node.parentId).sort(byNodeId);
  const capabilities = nodes.filter((node) => node.kind === "capability" && !node.parentId).sort(byNodeId);

  actors.forEach((node, index) => place(node, 36, 104 + index * 92, 178, 72, previous));
  artifacts.forEach((node, index) => place(node, 950, 104 + index * 92, 176, 72, previous));

  let flowBottom = 80;
  flows.forEach((flow, flowIndex) => {
    const flowSteps = children(nodes, flow.id, "step").sort(byNodeId);
    const runs = children(nodes, flow.id, "run").sort((a, b) => runPriority(a) - runPriority(b) || a.id.localeCompare(b.id));
    const stack = children(nodes, flow.id, "run-stack")[0];
    const stepRows = Math.max(1, Math.ceil(flowSteps.length / 4));
    const flowHeight = 72 + stepRows * 78 + 24 + runs.length * 164 + (stack ? 60 : 0) + 18;
    const y = 78 + flowIndex * (flowHeight + 54);
    place(flow, 232, y, 676, flowHeight, previous, false);
    flowBottom = Math.max(flowBottom, y + flowHeight);

    flowSteps.forEach((step, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      place(step, 252 + column * 158, y + 84 + row * 78, 146, 62, previous);
    });

    const runStartY = y + 72 + stepRows * 78 + 24;
    runs.forEach((run, runIndex) => {
      const runY = runStartY + runIndex * 164;
      place(run, 246, runY, 648, 146, previous, false);
      const runSteps = children(nodes, run.id, "step").sort(byNodeId);
      runSteps.forEach((step, index) => place(step, 266 + index * 156, runY + 78, 144, 56, previous));
    });

    if (stack) place(stack, 674, y + flowHeight - 58, 202, 44, previous);
  });

  const central = nodes.filter((node) => !node.parentId && !["actor", "flow", "artifact", "capability"].includes(node.kind)).sort(byNodeId);
  const centralStart = flows.length ? flowBottom + 50 : 104;
  central.forEach((node, index) => place(node, 260 + (index % 3) * 280, centralStart + Math.floor(index / 3) * 108, 250, 90, previous));

  const capabilityY = Math.max(690, flowBottom + 54, centralStart + Math.ceil(central.length / 3) * 108 + 60);
  capabilities.forEach((node, index) => place(node, 36 + (index % 6) * 186, capabilityY + Math.floor(index / 6) * 76, 176, 62, previous));

  const maxBottom = Math.max(capabilityY + Math.ceil(capabilities.length / 6) * 76 + 72, 760);
  for (const node of nodes) {
    if (node.x === undefined || node.y === undefined) place(node, 560, maxBottom - 100, 132, 50, previous);
  }

  return { ...model, nodes, width: 1160, height: maxBottom };
}

export function positionSnapshot(graph: PositionedGraph): Map<string, Point> {
  return new Map(graph.nodes.filter((node) => node.x !== undefined && node.y !== undefined).map((node) => [node.id, { x: node.x!, y: node.y! }]));
}

function place(node: VisualNode, x: number, y: number, width: number, height: number, previous: PositionSnapshot, preserve = true) {
  const saved = preserve ? previous.get(node.id) : undefined;
  node.x = saved?.x ?? x;
  node.y = saved?.y ?? y;
  node.width = width;
  node.height = height;
}

function children(nodes: VisualNode[], parentId: string, kind: VisualNode["kind"]): VisualNode[] {
  return nodes.filter((node) => node.parentId === parentId && node.kind === kind);
}

function byNodeId(a: VisualNode, b: VisualNode): number { return a.id.localeCompare(b.id); }
function runPriority(node: VisualNode): number {
  if (node.status === "blocked") return 0;
  if (node.status === "running" || node.status === "queued") return 1;
  if (node.status === "failed") return 2;
  return 3;
}
