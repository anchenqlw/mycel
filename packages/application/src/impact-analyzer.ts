import type { ChangeOperation, ControlResourceKind, ControlResourceReference, ImpactSummary } from "@mycel/domain";

export function orderChangeOperations(operations: ChangeOperation[]): ChangeOperation[] {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  if (byId.size !== operations.length) throw new Error("ChangeSet contains duplicate operation IDs");
  for (const operation of operations) {
    for (const dependency of operation.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`ChangeSet dependency not found: ${dependency}`);
    }
  }
  const ordered: ChangeOperation[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (operation: ChangeOperation) => {
    if (visited.has(operation.id)) return;
    if (visiting.has(operation.id)) throw new Error(`ChangeSet dependency cycle detected at ${operation.id}`);
    visiting.add(operation.id);
    for (const dependency of operation.dependsOn) visit(byId.get(dependency)!);
    visiting.delete(operation.id);
    visited.add(operation.id);
    ordered.push(operation);
  };
  for (const operation of operations) visit(operation);
  return ordered;
}

export function analyzeChangeSet(operations: ChangeOperation[]): ImpactSummary {
  orderChangeOperations(operations);
  const impact: ImpactSummary = {
    resourcesCreated: [], resourcesModified: [], resourcesArchived: [],
    permissionsAdded: [], runtimeEffects: [], warnings: [],
  };
  for (const operation of operations) {
    const resource = operationResource(operation);
    if (operation.kind.startsWith("create-")) impact.resourcesCreated.push(resource);
    else if (operation.kind.startsWith("archive-") || operation.kind === "remove-graph-edge") impact.resourcesArchived.push(resource);
    else impact.resourcesModified.push(resource);
    if (operation.kind.startsWith("publish-")) impact.runtimeEffects.push(`${resource.label} becomes the default for new runs or sessions`);
    collectPermissions(operation.payload, impact.permissionsAdded);
  }
  return impact;
}

function operationResource(operation: ChangeOperation): ControlResourceReference {
  const kind = resourceKind(operation.kind);
  const payloadId = typeof operation.payload.id === "string" ? operation.payload.id : undefined;
  const id = operation.targetId ?? payloadId ?? `pending:${operation.id}`;
  const label = typeof operation.payload.name === "string" ? operation.payload.name : id;
  return { kind, id, label };
}

function resourceKind(kind: ChangeOperation["kind"]): ControlResourceKind {
  if (kind.includes("worker-spec")) return "worker-spec";
  if (kind.includes("worker")) return "worker";
  if (kind.includes("flow")) return "flow";
  if (kind.includes("task")) return "task";
  return "graph";
}

function collectPermissions(value: unknown, result: string[], key = ""): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPermissions(item, result, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) collectPermissions(child, result, childKey);
    return;
  }
  if (typeof value === "string" && /permission|capabilit|tool/i.test(key) && !result.includes(value)) result.push(value);
}
