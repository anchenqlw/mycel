export type AgentAdapterKind = "claude-code" | "codex" | "mcp" | "a2a";
export type AgentSource = "adopted" | "graph-native";
export type AgentLifecycle = "run-scoped" | "flow-scoped" | "persistent" | "archived";
export type AgentRuntimeStatus = "online" | "offline" | "busy" | "degraded";

export interface AgentProfile {
  id: string;
  name: string;
  source: AgentSource;
  adapterKind: AgentAdapterKind;
  status: AgentRuntimeStatus;
  version?: string;
  capabilities: string[];
  contractLevel: "status" | "results" | "evidence" | "control";
  connectionUri?: string;
  lifecycle: AgentLifecycle;
  specVersionId?: string;
  parentAgentId?: string;
  subgraphId?: string;
  maxConcurrentSessions?: number;
  registeredAt: string;
  updatedAt: string;
}

export interface AgentSpec {
  id: string;
  agentId: string;
  version: number;
  engine: "claude-code" | "codex";
  prompt: string;
  skills: string[];
  tools: string[];
  fileRefs: string[];
  lifecycle: AgentLifecycle;
  memoryPolicy: "session" | "run" | "flow";
  maxTurns: number;
  maxBudgetUsd: number;
  canOrchestrate: boolean;
  maxDelegationDepth: number;
  maxFanOut: number;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  agentId: string;
  adapterKind: AgentAdapterKind;
  workId?: string;
  flowRunId?: string;
  specVersionId?: string;
  providerSessionId?: string;
  phase: "starting" | "running" | "blocked" | "completed" | "failed" | "interrupted" | "canceled";
  mode: "explore" | "execute";
  prompt: string;
  summary: string;
  lastEvent: string;
  rawContentExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowStepDefinition {
  id: string;
  name: string;
  kind: "agent" | "human";
  actorId: string;
  prompt: string;
  dependsOn: string[];
  condition: "always" | "previous-succeeded" | "previous-failed";
  timeoutMs: number;
  maxAttempts: number;
  join?: {
    mode: "all" | "any" | "quorum" | "race";
    quorum?: number;
  };
  requiredCapabilities?: string[];
}

export interface FlowBudget {
  maxRuntimeMs: number;
  maxTotalAttempts: number;
  maxCostUsd?: number;
}

export type FlowTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; intervalMs: number; timeOfDay?: string; timezone?: string }
  | { kind: "graph-event"; eventType: string }
  | { kind: "file-change"; glob: string }
  | { kind: "webhook"; key: string };

export interface FlowDefinition {
  id: string;
  name: string;
  description: string;
  workspaceId?: string;
  status: "draft" | "published" | "paused" | "retired";
  version: number;
  trigger: FlowTrigger;
  steps: FlowStepDefinition[];
  permissionCeiling: string[];
  maxConcurrency?: number;
  budget?: FlowBudget;
  createdAt: string;
  updatedAt: string;
}

export interface FlowRun {
  id: string;
  flowId: string;
  flowVersion: number;
  phase: "queued" | "running" | "blocked" | "completed" | "failed" | "canceled";
  triggerKind: FlowTrigger["kind"];
  flowSnapshot?: FlowDefinition;
  currentStepIds: string[];
  completedStepIds: string[];
  failedStepIds: string[];
  skippedStepIds?: string[];
  blockedStepIds?: string[];
  totalAttempts?: number;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export type StepRunPhase = "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "skipped" | "cancelled";

export interface StepRun {
  id: string;
  flowRunId: string;
  stepId: string;
  actorId: string;
  phase: StepRunPhase;
  selectedDependencyStepRunIds: string[];
  activeAttemptId?: string;
  resultId?: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface StepAttempt {
  id: string;
  stepRunId: string;
  ordinal: number;
  phase: "starting" | "running" | "blocked" | "completed" | "failed" | "interrupted" | "cancelled";
  requestedActorId: string;
  producerActorId?: string;
  agentSessionId?: string;
  humanTaskId?: string;
  permissionLeaseId: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface StepArtifactRef {
  artifactId: string;
  uri: string;
  mediaType: string;
  sha256: string;
  summary: string;
}

export interface StepResult {
  id: string;
  flowRunId: string;
  stepRunId: string;
  attemptId: string;
  producerActorId: string;
  status: "completed" | "failed" | "cancelled" | "skipped";
  summary: string;
  output: unknown;
  artifacts: StepArtifactRef[];
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface HumanTask {
  id: string;
  flowRunId: string;
  stepRunId: string;
  attemptId: string;
  assignedActorId: string;
  claimedByActorId?: string;
  phase: "open" | "claimed" | "completed" | "failed" | "cancelled";
  instructions: string;
  dependencyResultIds: string[];
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionLease {
  id: string;
  flowRunId: string;
  stepRunId?: string;
  actorId: string;
  capabilities: string[];
  workspaceScopes: string[];
  maxRuntimeMs: number;
  maxAttempts: number;
  maxCostUsd?: number;
  expiresAt: string;
  sourceApprovalId?: string;
  status: "active" | "expired" | "revoked";
}

export interface PermissionRequest {
  id: string;
  flowRunId: string;
  stepRunId: string;
  actorId: string;
  requestedCapabilities: string[];
  reason: string;
  phase: "open" | "approved" | "denied" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface AgentStepExecutionResult {
  status: "completed" | "blocked" | "failed";
  summary: string;
  output?: unknown;
  artifacts?: StepArtifactRef[];
  agentSessionId?: string;
  error?: string;
}

export type CollaborationChange =
  | { kind: "step-run"; entity: StepRun }
  | { kind: "step-attempt"; entity: StepAttempt }
  | { kind: "step-result"; entity: StepResult }
  | { kind: "human-task"; entity: HumanTask }
  | { kind: "permission-lease"; entity: PermissionLease }
  | { kind: "permission-request"; entity: PermissionRequest };

export interface AttentionItem {
  id: string;
  kind: "decision" | "acceptance" | "blocked" | "running";
  title: string;
  aggregateId: string;
  actorId: string;
  status: "open" | "resolved";
  createdAt: string;
  updatedAt: string;
}
