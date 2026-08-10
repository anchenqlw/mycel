import type { ControlResourceKind, ControlResourceReference } from "@mycel/domain";
import type { AppProjection } from "./projection.js";

export type ResourceResolution =
  | { kind: "resolved"; resource: ControlResourceReference }
  | { kind: "ambiguous"; candidates: ControlResourceReference[] }
  | { kind: "not-found"; query: string };

export function resolveControlResource(
  projection: AppProjection,
  input: { kind: ControlResourceKind; query: string; focusedIds?: string[] },
): ResourceResolution {
  const candidates = resourcesOfKind(projection, input.kind);
  const exact = candidates.find((candidate) => candidate.id === input.query);
  if (exact) return { kind: "resolved", resource: exact };

  const normalized = normalize(input.query);
  const nameMatches = candidates.filter((candidate) => normalize(candidate.label) === normalized);
  if (nameMatches.length === 1) return { kind: "resolved", resource: nameMatches[0]! };
  if (nameMatches.length > 1) {
    const focused = nameMatches.filter((candidate) => input.focusedIds?.includes(candidate.id));
    if (focused.length === 1) return { kind: "resolved", resource: focused[0]! };
    return { kind: "ambiguous", candidates: nameMatches.sort(byId) };
  }

  const partial = candidates.filter((candidate) => normalize(candidate.label).includes(normalized));
  if (partial.length === 1) return { kind: "resolved", resource: partial[0]! };
  if (partial.length > 1) return { kind: "ambiguous", candidates: partial.sort(byId) };
  return { kind: "not-found", query: input.query };
}

export function resourcesOfKind(projection: AppProjection, kind: ControlResourceKind): ControlResourceReference[] {
  switch (kind) {
    case "graph": return [{ kind, id: "graph:main", label: "Production graph", version: Math.max(1, projection.graph.version) }];
    case "worker": return Object.values(projection.workers).map((item) => ({ kind, id: item.id, label: item.name }));
    case "worker-spec": return Object.values(projection.workerSpecs).map((item) => ({ kind, id: item.id, label: item.id, version: item.version }));
    case "flow": return Object.values(projection.flows).map((item) => ({ kind, id: item.id, label: item.name, version: item.version }));
    case "flow-run": return Object.values(projection.flowRuns).map((item) => ({ kind, id: item.id, label: `${item.flowId} · ${item.phase}` }));
    case "task": return Object.values(projection.tasks).map((item) => ({ kind, id: item.id, label: item.title, version: item.version }));
    case "worker-session": return Object.values(projection.workerSessions).map((item) => ({ kind, id: item.id, label: item.summary || `${item.workerId} session` }));
    case "human-task": return Object.values(projection.humanTasks).map((item) => ({ kind, id: item.id, label: item.instructions }));
    case "evidence": return Object.values(projection.evidence).map((item) => ({ kind, id: item.artifactId, label: item.summary }));
    case "history": return [{ kind, id: "history:all", label: "History" }];
    case "workspace":
    case "file": return [];
  }
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function byId(left: ControlResourceReference, right: ControlResourceReference): number {
  return left.id.localeCompare(right.id);
}
