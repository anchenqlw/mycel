export type VisualKind = "actor" | "flow" | "step" | "run" | "run-stack" | "artifact" | "capability" | "work";

export interface SourceGraphNode {
  id: string;
  name?: string;
  type: "actor" | "work" | "artifact" | "capability";
  kind?: string;
  status?: string;
  source?: string;
  subgraphId?: string;
}

export interface SourceGraphEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  role?: string;
  scope?: string;
}

export interface SourceFlowStep {
  id: string;
  name: string;
  actorId: string;
  dependsOn: string[];
  requiredCapabilities?: string[];
}

export interface SourceFlow {
  id: string;
  name: string;
  status: string;
  version: number;
  permissionCeiling: string[];
  steps: SourceFlowStep[];
}

export interface SourceFlowRun {
  id: string;
  flowId: string;
  phase: string;
  currentStepIds: string[];
  completedStepIds: string[];
  failedStepIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SourceStepRun {
  id: string;
  flowRunId: string;
  stepId: string;
  actorId: string;
  phase: string;
  resultId?: string;
}

export interface SourceStepResult {
  id: string;
  stepRunId: string;
  artifacts: Array<{ artifactId: string; summary: string; uri: string }>;
}

export interface SourcePermissionLease {
  id: string;
  actorId: string;
  flowRunId: string;
  capabilities: string[];
  status: string;
}

export interface GraphProjectionInput {
  graph: { version: number; nodes: SourceGraphNode[]; edges: SourceGraphEdge[] };
  flows: Record<string, SourceFlow>;
  flowRuns: Record<string, SourceFlowRun>;
  stepRuns: Record<string, SourceStepRun>;
  stepResults: Record<string, SourceStepResult>;
  permissionLeases: Record<string, SourcePermissionLease>;
}

export interface VisualNode {
  id: string;
  label: string;
  kind: VisualKind;
  status: string;
  sourceId?: string;
  parentId?: string;
  actorId?: string;
  meta?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface VisualEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  role?: string;
  status?: string;
}

export interface GraphDiagnostic {
  code: "MISSING_EDGE_SOURCE" | "MISSING_EDGE_TARGET" | "INCOMPLETE_RUN";
  entityId: string;
  message: string;
}

export interface LivingGraphViewModel {
  nodes: VisualNode[];
  edges: VisualEdge[];
  diagnostics: GraphDiagnostic[];
}

export interface PositionedGraph extends LivingGraphViewModel {
  width: number;
  height: number;
}

export interface GraphSelection {
  id: string;
  label: string;
  kind: VisualKind | "edge";
  status: string;
  sourceId?: string;
  relations: Array<{ id: string; type: string; direction: "in" | "out"; targetId: string; targetLabel: string }>;
}

export interface Point {
  x: number;
  y: number;
}
