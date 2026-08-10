import type { LivingGraphViewModel } from "./graph-model.js";

export function oneHopNeighborhood(model: LivingGraphViewModel, selectedId: string): Set<string> {
  const result = new Set<string>([selectedId]);
  for (const edge of model.edges) {
    if (edge.from === selectedId) result.add(edge.to);
    if (edge.to === selectedId) result.add(edge.from);
  }
  return result;
}

export function matchesEmphasis(kind: string, status: string, emphasizedKinds: ReadonlySet<string>, emphasizedStatuses: ReadonlySet<string>): boolean {
  const kindMatch = emphasizedKinds.size === 0 || emphasizedKinds.has(kind) || emphasizedKinds.has(kind === "run-stack" ? "run" : kind);
  const statusMatch = emphasizedStatuses.size === 0 || emphasizedStatuses.has(status);
  return kindMatch && statusMatch;
}
