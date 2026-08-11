import {
  GraphNodeSchema,
  GraphEdgeSchema,
  parseChangeOperationPayload,
  validateChangeOperation,
  type ChangeOperation,
  type FlowDefinition,
  type FlowStepDefinition,
  type GraphEdge,
  type GraphNode,
} from "@mycel/domain";

export interface MaterializationActor {
  id: string;
  kind: "human" | "agent";
}

export interface ChangeMaterializationContext {
  changeSetId: string;
  now: string;
  actors: ReadonlyMap<string, MaterializationActor>;
  workspaces: ReadonlyMap<string, string>;
  flows: ReadonlyMap<string, FlowDefinition>;
  graphNodeIds: ReadonlySet<string>;
}

export function validateMaterializableChange(operation: ChangeOperation, context: ChangeMaterializationContext, operations: readonly ChangeOperation[]): void {
  const validation = validateChangeOperation(operation);
  if (!validation.ok) {
    throw new Error(`${validation.kind} ${validation.field}: ${validation.message}`);
  }
  switch (operation.kind) {
    case "create-flow":
      materializeCreateFlow(operation, context);
      return;
    case "update-flow":
      materializeUpdateFlow(operation, context);
      return;
    case "create-graph-node":
      materializeGraphNode(operation, context);
      return;
    case "create-graph-edge":
      validateGraphEdge(operation, operations, context);
      return;
    case "publish-flow":
      validateFlowReference(operation, operations, context);
      return;
    default:
      return;
  }
}

function validateGraphEdge(operation: ChangeOperation, operations: readonly ChangeOperation[], context: ChangeMaterializationContext): void {
  const results = priorOperationResults(operation, operations, context);
  const edge = materializeGraphEdge(operation, context, results);
  const proposedIds = new Set(Object.values(results).map((value) => objectValue(value)).map((value) => value && stringValue(value.id)).filter((value): value is string => Boolean(value)));
  if (!context.graphNodeIds.has(edge.from) && !proposedIds.has(edge.from)) throw new Error("create-graph-edge source is not available");
  if (!context.graphNodeIds.has(edge.to) && !proposedIds.has(edge.to)) throw new Error("create-graph-edge target is not available");
}

export function materializeUpdateFlow(operation: ChangeOperation, context: ChangeMaterializationContext): FlowDefinition {
  if (operation.kind !== "update-flow") throw new Error("update-flow operation is required");
  const payload = parseChangeOperationPayload(operation);
  const targetId = stringValue(operation.targetId) ?? stringValue(payload.flowId);
  if (!targetId) throw new Error("update-flow target reference is required");
  const existing = context.flows.get(targetId);
  if (!existing) throw new Error("update-flow target is not available");
  const patch = objectValue(payload.patch);
  if (!patch) throw new Error("update-flow patch is required");
  const flowContext = resolvePlanAliases(patch, context);
  const workspaceReference = stringValue(patch.workspaceId) ?? stringValue(patch.workspaceRef);
  const steps = Array.isArray(patch.steps) ? patch.steps.map((value, index) => materializeStep(value, index, flowContext)) : existing.steps;
  const budgetPatch = objectValue(patch.budget) as NonNullable<FlowDefinition["budget"]> | undefined;
  const flow: FlowDefinition = {
    ...existing,
    ...(stringValue(patch.name) ? { name: stringValue(patch.name)! } : {}),
    ...(typeof patch.description === "string" ? { description: patch.description } : {}),
    ...(workspaceReference ? { workspaceId: resolveWorkspace(workspaceReference, flowContext) } : {}),
    ...(objectValue(patch.trigger) ? { trigger: objectValue(patch.trigger) as FlowDefinition["trigger"] } : {}),
    steps,
    ...(Array.isArray(patch.permissionCeiling) ? { permissionCeiling: stringArray(patch.permissionCeiling) } : {}),
    ...(positiveInteger(patch.maxConcurrency) ? { maxConcurrency: positiveInteger(patch.maxConcurrency)! } : {}),
    ...(budgetPatch ? { budget: budgetPatch } : {}),
    id: existing.id,
    status: existing.status,
    version: existing.version + 1,
    createdAt: existing.createdAt,
    updatedAt: context.now,
  };
  assertMaterializedFlow(flow);
  return flow;
}

export function materializeCreateFlow(operation: ChangeOperation, context: ChangeMaterializationContext): Omit<FlowDefinition, "createdAt" | "updatedAt"> & { createdAt: string; updatedAt: string } {
  if (operation.kind !== "create-flow") throw new Error("create-flow operation is required");
  const validation = validateChangeOperation(operation);
  if (!validation.ok) throw new Error(`${validation.kind} ${validation.field}: ${validation.message}`);
  const payload = parseChangeOperationPayload(operation);
  const source = objectValue(payload.flow) ?? payload;
  const name = requiredString(source.name, "create-flow name");
  const flowContext = resolvePlanAliases(source, context);
  const stepsSource = Array.isArray(source.steps) ? source.steps : [];
  const steps = stepsSource.map((value, index) => materializeStep(value, index, flowContext));
  const workspaceReference = stringValue(source.workspaceId) ?? stringValue(source.workspaceRef);
  const declaredWorkspace = Array.isArray(source.workspaces) && source.workspaces.length === 1 ? stringValue(objectValue(source.workspaces[0])?.id) : undefined;
  const workspaceId = workspaceReference || declaredWorkspace ? resolveWorkspace(workspaceReference ?? declaredWorkspace!, flowContext) : undefined;
  const trigger = objectValue(source.trigger) as FlowDefinition["trigger"] | undefined;
  const budget = objectValue(source.budget) as FlowDefinition["budget"] | undefined;

  const flow: FlowDefinition = {
    id: `flow:${stablePart(context.changeSetId)}:${stablePart(operation.id)}`,
    name,
    description: stringValue(source.description) ?? "",
    ...(workspaceId ? { workspaceId } : {}),
    status: "draft",
    version: 0,
    trigger: trigger ?? { kind: "manual" },
    steps,
    permissionCeiling: stringArray(source.permissionCeiling),
    ...(positiveInteger(source.maxConcurrency) ? { maxConcurrency: positiveInteger(source.maxConcurrency)! } : {}),
    ...(budget ? { budget } : {}),
    createdAt: context.now,
    updatedAt: context.now,
  };
  assertMaterializedFlow(flow);
  return flow;
}

function resolvePlanAliases(source: Record<string, unknown>, context: ChangeMaterializationContext): ChangeMaterializationContext {
  const actors = new Map(context.actors);
  for (const value of Array.isArray(source.actors) ? source.actors : []) {
    const actor = objectValue(value);
    if (!actor) throw new Error("create-flow actors must be objects");
    const alias = requiredString(actor.id, "create-flow actors.id");
    const existingActorId = requiredString(actor.existingActorId, `create-flow actor ${alias}.existingActorId`);
    actors.set(alias, resolveActor(existingActorId, context));
  }
  const workspaces = new Map(context.workspaces);
  for (const value of Array.isArray(source.workspaces) ? source.workspaces : []) {
    const workspace = objectValue(value);
    if (!workspace) throw new Error("create-flow workspaces must be objects");
    const alias = requiredString(workspace.id, "create-flow workspaces.id");
    const workspaceId = requiredString(workspace.workspaceId, `create-flow workspace ${alias}.workspaceId`);
    workspaces.set(alias, resolveWorkspace(workspaceId, context));
  }
  return { ...context, actors, workspaces };
}

export function materializeGraphNode(operation: ChangeOperation, context: ChangeMaterializationContext): GraphNode {
  if (operation.kind !== "create-graph-node") throw new Error("create-graph-node operation is required");
  const payload = parseChangeOperationPayload(operation);
  const source = objectValue(payload.node) ?? payload;
  const scope = stringValue(source.scope);
  const resolvedScope = scope ? context.workspaces.get(scope) ?? scope : undefined;
  const base = {
    ...source,
    id: stringValue(source.id) ?? `node:${stablePart(context.changeSetId)}:${stablePart(operation.id)}`,
    createdAt: context.now,
    updatedAt: context.now,
  };
  delete (base as Record<string, unknown>).archivedAt;
  if (source.type === "actor") return GraphNodeSchema.parse({ ...base, status: "online", lifecycle: "persistent" });
  if (source.type === "work") return GraphNodeSchema.parse({ ...base, status: "proposed" });
  return GraphNodeSchema.parse({ ...base, ...(resolvedScope ? { scope: resolvedScope } : {}) });
}

export function materializeGraphEdge(
  operation: ChangeOperation,
  context: ChangeMaterializationContext,
  appliedResults: Readonly<Record<string, unknown>>,
): GraphEdge {
  if (operation.kind !== "create-graph-edge") throw new Error("create-graph-edge operation is required");
  const payload = parseChangeOperationPayload(operation);
  const source = objectValue(payload.edge) ?? payload;
  const from = resolveEdgeEndpoint(source.from, source.fromRef, context, appliedResults, "from");
  const to = resolveEdgeEndpoint(source.to, source.toRef, context, appliedResults, "to");
  const permission = normalizePermission(source.permission);
  if (source.permission !== undefined && !permission) throw new Error("create-graph-edge permission is not supported");
  const scope = stringValue(source.scope);
  return GraphEdgeSchema.parse({
    ...source,
    id: stringValue(source.id) ?? `edge:${stablePart(context.changeSetId)}:${stablePart(operation.id)}`,
    from,
    to,
    ...(permission ? { permission } : {}),
    ...(scope ? { scope: context.workspaces.get(scope) ?? scope } : {}),
  });
}

export function resolveFlowTarget(operation: ChangeOperation, appliedResults: Readonly<Record<string, unknown>>): string {
  const payload = parseChangeOperationPayload(operation);
  const direct = stringValue(operation.targetId) ?? stringValue(payload.flowId);
  if (direct) return direct;
  const reference = stringValue(payload.flowRef);
  if (!reference) throw new Error("publish-flow target reference is required");
  const result = objectValue(appliedResults[reference]);
  const id = result ? stringValue(result.id) : undefined;
  if (!id || !id.startsWith("flow:")) throw new Error("publish-flow reference did not produce a Flow");
  return id;
}

function validateFlowReference(operation: ChangeOperation, operations: readonly ChangeOperation[], context: ChangeMaterializationContext): void {
  const direct = stringValue(operation.targetId) ?? stringValue(operation.payload.flowId);
  if (direct) {
    if (!context.flows.has(direct)) throw new Error("publish-flow target is not available");
    return;
  }
  const reference = stringValue(operation.payload.flowRef);
  if (!reference) throw new Error("publish-flow target reference is required");
  const index = operations.findIndex((candidate) => candidate.id === operation.id);
  const sourceIndex = operations.findIndex((candidate) => candidate.id === reference);
  if (sourceIndex < 0 || sourceIndex >= index) throw new Error("publish-flow flowRef must reference a prior operation");
  if (operations[sourceIndex]?.kind !== "create-flow") throw new Error("publish-flow flowRef must reference create-flow");
  if (!operation.dependsOn.includes(reference)) throw new Error("publish-flow must depend on its flowRef");
}

function priorOperationResults(operation: ChangeOperation, operations: readonly ChangeOperation[], context: ChangeMaterializationContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const index = operations.findIndex((candidate) => candidate.id === operation.id);
  for (const reference of [stringValue(operation.payload.fromRef), stringValue(operation.payload.toRef), stringValue(objectValue(operation.payload.edge)?.fromRef), stringValue(objectValue(operation.payload.edge)?.toRef)].filter((value): value is string => Boolean(value))) {
    const sourceIndex = operations.findIndex((candidate) => candidate.id === reference);
    if (sourceIndex < 0 || sourceIndex >= index) throw new Error("create-graph-edge reference must name a prior operation");
    if (!operation.dependsOn.includes(reference)) throw new Error("create-graph-edge must depend on referenced operations");
    const source = operations[sourceIndex]!;
    if (source.kind === "create-graph-node") result[reference] = materializeGraphNode(source, context);
    else if (source.kind === "create-worker") result[reference] = { id: `pending:${stablePart(reference)}` };
    else throw new Error("create-graph-edge reference did not produce a graph endpoint");
  }
  return result;
}

function materializeStep(value: unknown, index: number, context: ChangeMaterializationContext): FlowStepDefinition {
  const source = objectValue(value);
  if (!source) throw new Error(`create-flow steps.${index} must be an object`);
  const reference = stringValue(source.actorId) ?? stringValue(source.actorRef) ?? stringValue(source.existingActorId);
  if (!reference) throw new Error(`create-flow steps.${index}.actor reference is required`);
  const actor = resolveActor(reference, context);
  const join = objectValue(source.join) as NonNullable<FlowStepDefinition["join"]> | undefined;
  return {
    id: requiredString(source.id, `create-flow steps.${index}.id`),
    name: requiredString(source.name, `create-flow steps.${index}.name`),
    kind: actor.kind,
    actorId: actor.id,
    prompt: stringValue(source.prompt) ?? requiredString(source.name, `create-flow steps.${index}.name`),
    dependsOn: stringArray(source.dependsOn),
    condition: conditionValue(source.condition),
    timeoutMs: positiveInteger(source.timeoutMs) ?? 300_000,
    maxAttempts: positiveInteger(source.maxAttempts) ?? 1,
    ...(join ? { join } : {}),
    ...(Array.isArray(source.requiredCapabilities) ? { requiredCapabilities: stringArray(source.requiredCapabilities) } : {}),
  };
}

function resolveActor(reference: string, context: ChangeMaterializationContext): MaterializationActor {
  const actor = context.actors.get(reference) ?? [...context.actors.values()].find((candidate) => candidate.id === reference);
  if (!actor) throw new Error(`create-flow actor reference is not available: ${reference}`);
  return actor;
}

function resolveWorkspace(reference: string, context: ChangeMaterializationContext): string {
  const workspaceId = context.workspaces.get(reference) ?? [...context.workspaces.values()].find((candidate) => candidate === reference);
  if (!workspaceId) throw new Error(`create-flow workspace reference is not available: ${reference}`);
  return workspaceId;
}

function resolveEdgeEndpoint(
  directValue: unknown,
  referenceValue: unknown,
  context: ChangeMaterializationContext,
  appliedResults: Readonly<Record<string, unknown>>,
  label: "from" | "to",
): string {
  const reference = stringValue(referenceValue);
  if (reference) {
    const result = objectValue(appliedResults[reference]);
    const resolved = result ? stringValue(result.id) : undefined;
    if (resolved) return resolved;
  }
  const direct = stringValue(directValue);
  if (!direct) throw new Error(`create-graph-edge ${label} reference is required`);
  return context.actors.get(direct)?.id ?? direct;
}

function normalizePermission(value: unknown): GraphEdge["permission"] | undefined {
  if (value === "repository-read") return "read";
  if (value === "repository-write") return "write";
  if (value === "read" || value === "write" || value === "execute" || value === "delegate") return value;
  return undefined;
}

function stablePart(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9:._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("host resource identifier cannot be empty");
  return sanitized;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function conditionValue(value: unknown): FlowStepDefinition["condition"] {
  return value === "always" || value === "previous-failed" || value === "previous-succeeded" ? value : "previous-succeeded";
}

function assertMaterializedFlow(flow: FlowDefinition): void {
  if (flow.steps.length === 0) throw new Error("create-flow requires at least one step");
  if ((flow.maxConcurrency ?? 4) > 32) throw new Error("create-flow maxConcurrency must be between 1 and 32");
  if (flow.trigger.kind === "schedule") {
    if (flow.trigger.intervalMs < 10_000) throw new Error("create-flow schedule interval must be at least 10 seconds");
    if (Boolean(flow.trigger.timeOfDay) !== Boolean(flow.trigger.timezone)) throw new Error("create-flow schedule timeOfDay and timezone must be provided together");
    if (flow.trigger.timeOfDay && flow.trigger.intervalMs !== 86_400_000) throw new Error("create-flow wall-clock schedules currently require a daily interval");
    if (flow.trigger.timezone) {
      try { new Intl.DateTimeFormat("en", { timeZone: flow.trigger.timezone }).format(new Date(0)); }
      catch { throw new Error("create-flow schedule timezone must be a valid IANA timezone"); }
    }
  }
  const byId = new Map(flow.steps.map((step) => [step.id, step]));
  if (byId.size !== flow.steps.length) throw new Error("create-flow step IDs must be unique");
  for (const step of flow.steps) {
    if (step.timeoutMs < 1_000) throw new Error(`create-flow step ${step.id} timeout must be at least one second`);
    if (step.maxAttempts > 10) throw new Error(`create-flow step ${step.id} maxAttempts must not exceed 10`);
    for (const dependency of step.dependsOn) if (!byId.has(dependency)) throw new Error(`create-flow step ${step.id} has an unknown dependency`);
    if (step.join?.mode === "quorum" && (step.dependsOn.length < 2 || !step.join.quorum || step.join.quorum > step.dependsOn.length)) {
      throw new Error(`create-flow step ${step.id} has an invalid quorum`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) throw new Error("create-flow graph must be acyclic");
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const dependency of byId.get(stepId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of flow.steps) visit(step.id);
}
