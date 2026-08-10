import type { AgentProfile, AgentSpec, FlowDefinition, PlanDiagnostic, ProductionPlan } from "@mycel/domain";
import { ulid } from "ulid";

export interface PlanEnvironment {
  actorIds: Set<string>;
  workspaceIds: Set<string>;
}

export interface CompiledProductionPlan {
  flow: Omit<FlowDefinition, "createdAt" | "updatedAt">;
  agents: Array<{ profile: AgentProfile; spec: AgentSpec }>;
}

export function validateProductionPlan(plan: ProductionPlan, environment: PlanEnvironment): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  const actorIds = new Set(plan.actors.map((actor) => actor.id));
  const workspaceIds = new Set(plan.workspaces.map((workspace) => workspace.id));
  const stepIds = new Set(plan.steps.map((step) => step.id));
  duplicateDiagnostics(plan.actors.map((actor) => actor.id), "actors", diagnostics);
  duplicateDiagnostics(plan.workspaces.map((workspace) => workspace.id), "workspaces", diagnostics);
  duplicateDiagnostics(plan.steps.map((step) => step.id), "steps", diagnostics);

  plan.actors.forEach((actor, index) => {
    if (actor.kind !== "graph-agent" && (!actor.existingActorId || !environment.actorIds.has(actor.existingActorId))) {
      diagnostics.push({ code: "UNKNOWN_ACTOR", path: `actors.${index}.existingActorId`, message: `Actor ${actor.name} must reference a registered Actor.` });
    }
    if (actor.kind === "graph-agent" && (!actor.engine || !actor.prompt)) {
      diagnostics.push({ code: "INCOMPLETE_HARNESS", path: `actors.${index}`, message: `Graph Agent ${actor.name} requires an engine and harness prompt.` });
    }
  });
  plan.workspaces.forEach((workspace, index) => {
    if (!environment.workspaceIds.has(workspace.workspaceId)) diagnostics.push({ code: "UNKNOWN_WORKSPACE", path: `workspaces.${index}.workspaceId`, message: `Workspace binding ${workspace.workspaceId} is not registered.` });
  });
  plan.steps.forEach((step, index) => {
    if (!actorIds.has(step.actorId)) diagnostics.push({ code: "UNKNOWN_PLAN_ACTOR", path: `steps.${index}.actorId`, message: `Step ${step.name} references unknown plan actor ${step.actorId}.` });
    for (const workspaceId of step.workspaceIds) if (!workspaceIds.has(workspaceId)) diagnostics.push({ code: "UNKNOWN_PLAN_WORKSPACE", path: `steps.${index}.workspaceIds`, message: `Step ${step.name} references unknown plan workspace ${workspaceId}.` });
    for (const dependency of step.dependsOn) if (!stepIds.has(dependency)) diagnostics.push({ code: "UNKNOWN_DEPENDENCY", path: `steps.${index}.dependsOn`, message: `Step ${step.name} depends on unknown step ${dependency}.` });
    if (step.dependsOn.includes(step.id)) diagnostics.push({ code: "SELF_DEPENDENCY", path: `steps.${index}.dependsOn`, message: `Step ${step.name} cannot depend on itself.` });
    if (step.join.mode === "quorum" && step.join.quorum > step.dependsOn.length) diagnostics.push({ code: "INVALID_QUORUM", path: `steps.${index}.join.quorum`, message: `Quorum cannot exceed dependency count.` });
    for (const capability of step.requiredCapabilities) if (!plan.permissionCeiling.includes(capability)) diagnostics.push({ code: "CAPABILITY_OVER_CEILING", path: `steps.${index}.requiredCapabilities`, message: `${capability} is outside the plan permission ceiling.` });
  });
  if (hasCycle(plan.steps.map((step) => ({ id: step.id, dependencies: step.dependsOn })))) diagnostics.push({ code: "DEPENDENCY_CYCLE", path: "steps", message: "Step dependencies must form an acyclic graph." });
  const totalAttempts = plan.steps.reduce((total, step) => total + step.maxAttempts, 0);
  if (totalAttempts > plan.budget.maxTotalAttempts) diagnostics.push({ code: "ATTEMPT_BUDGET_TOO_LOW", path: "budget.maxTotalAttempts", message: `Budget allows ${plan.budget.maxTotalAttempts} attempts but steps can require ${totalAttempts}.` });
  return diagnostics;
}

export function compileProductionPlan(plan: ProductionPlan, proposalId: string, now = new Date().toISOString()): CompiledProductionPlan {
  const suffix = safeId(proposalId).slice(-32);
  const actorMap = new Map<string, string>();
  const agents: CompiledProductionPlan["agents"] = [];
  for (const actor of plan.actors) {
    if (actor.kind !== "graph-agent") {
      actorMap.set(actor.id, actor.existingActorId!);
      continue;
    }
    const agentId = `agent:native:${safeId(actor.id)}:${suffix}`;
    const specId = `artifact:agent-spec:${agentId}:v1`;
    actorMap.set(actor.id, agentId);
    const spec: AgentSpec = {
      id: specId, agentId, version: 1, engine: actor.engine!, prompt: actor.prompt!, skills: actor.skills,
      tools: actor.tools.length ? actor.tools : ["Read", "Glob", "Grep"], fileRefs: [], lifecycle: "flow-scoped", memoryPolicy: "flow",
      maxTurns: 24, maxBudgetUsd: 5, canOrchestrate: false, maxDelegationDepth: 0, maxFanOut: 0, createdAt: now,
    };
    agents.push({
      spec,
      profile: { id: agentId, name: actor.name, source: "graph-native", adapterKind: actor.engine!, status: "online", capabilities: [...new Set([actor.engine!, ...actor.skills, ...spec.tools])], contractLevel: "control", lifecycle: "flow-scoped", specVersionId: specId, registeredAt: now, updatedAt: now },
    });
  }
  const trigger = plan.trigger.kind === "schedule"
    ? { kind: "schedule" as const, intervalMs: plan.trigger.intervalMs }
    : plan.trigger.kind === "manual" ? { kind: "manual" as const }
    : plan.trigger.kind === "graph-event" ? { kind: "graph-event" as const, eventType: plan.trigger.eventType }
    : plan.trigger.kind === "file-change" ? { kind: "file-change" as const, glob: plan.trigger.glob }
    : { kind: "webhook" as const, key: plan.trigger.key };
  return {
    agents,
    flow: {
      id: `flow:steward:${suffix}`,
      name: plan.title,
      description: plan.trigger.kind === "schedule" ? `${plan.summary}\nSchedule: ${plan.trigger.timeOfDay} ${plan.trigger.timezone}` : plan.summary,
      ...(plan.workspaces[0]?.workspaceId ? { workspaceId: plan.workspaces[0].workspaceId } : {}),
      status: "draft",
      version: 0,
      trigger,
      steps: plan.steps.map((step) => ({ id: step.id, name: step.name, kind: plan.actors.find((actor) => actor.id === step.actorId)?.kind === "human" ? "human" : "agent", actorId: actorMap.get(step.actorId)!, prompt: step.prompt, dependsOn: step.dependsOn, condition: step.condition, timeoutMs: step.timeoutMs, maxAttempts: step.maxAttempts, join: step.join, requiredCapabilities: step.requiredCapabilities })),
      permissionCeiling: plan.permissionCeiling,
      maxConcurrency: 4,
      budget: { maxRuntimeMs: plan.budget.maxRuntimeMs, maxTotalAttempts: plan.budget.maxTotalAttempts, ...(plan.budget.maxCostUsd !== undefined ? { maxCostUsd: plan.budget.maxCostUsd } : {}) },
    },
  };
}

export function proposalId(): string { return `proposal_${ulid()}`; }

function duplicateDiagnostics(values: string[], path: string, diagnostics: PlanDiagnostic[]): void {
  const seen = new Set<string>();
  values.forEach((value, index) => { if (seen.has(value)) diagnostics.push({ code: "DUPLICATE_ID", path: `${path}.${index}.id`, message: `Duplicate id ${value}.` }); seen.add(value); });
}

function hasCycle(nodes: Array<{ id: string; dependencies: string[] }>): boolean {
  const graph = new Map(nodes.map((node) => [node.id, node.dependencies]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); for (const dependency of graph.get(id) ?? []) if (graph.has(dependency) && visit(dependency)) return true; visiting.delete(id); visited.add(id); return false; };
  return nodes.some((node) => visit(node.id));
}

function safeId(value: string): string { return value.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 80); }
