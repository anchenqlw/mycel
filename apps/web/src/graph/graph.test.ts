import { describe, expect, it } from "vitest";
import { oneHopNeighborhood } from "./graph-focus.js";
import { layoutLivingGraph, positionSnapshot } from "./graph-layout.js";
import type { GraphProjectionInput } from "./graph-model.js";
import { buildLivingGraph } from "./graph-projection.js";

const input: GraphProjectionInput = {
  graph: {
    version: 1,
    nodes: [
      { id: "human:owner", name: "Owner", type: "actor", kind: "human", status: "online" },
      { id: "agent:claude", name: "Claude", type: "actor", kind: "agent", status: "online" },
      { id: "artifact:spec", name: "Agent spec", type: "artifact", kind: "agent-spec", status: "active" },
      { id: "cap:read", name: "Repository read", type: "capability", kind: "repository-read", status: "active" },
      { id: "work:flow:flow:daily", name: "Daily intelligence", type: "work", kind: "flow", status: "approved" },
      { id: "work:flow:flow:daily:v1:analyze", name: "Analyze", type: "work", kind: "step", status: "proposed" },
    ],
    edges: [
      { id: "configured", type: "configured_by", from: "agent:claude", to: "artifact:spec" },
      { id: "equipped", type: "equipped_with", from: "agent:claude", to: "cap:read" },
      { id: "graph-contains", type: "contains", from: "work:flow:flow:daily", to: "work:flow:flow:daily:v1:analyze" },
    ],
  },
  flows: {
    "flow:daily": {
      id: "flow:daily", name: "Daily intelligence", status: "published", version: 1, permissionCeiling: ["repository-read"],
      steps: [
        { id: "analyze", name: "Analyze", actorId: "agent:claude", dependsOn: [], requiredCapabilities: ["repository-read"] },
        { id: "review", name: "Review", actorId: "human:owner", dependsOn: ["analyze"], requiredCapabilities: [] },
      ],
    },
  },
  flowRuns: {
    "run:active": { id: "run:active", flowId: "flow:daily", phase: "running", currentStepIds: ["analyze"], completedStepIds: [], failedStepIds: [], createdAt: "2026-08-04T01:00:00Z", updatedAt: "2026-08-04T01:01:00Z" },
    "run:complete": { id: "run:complete", flowId: "flow:daily", phase: "completed", currentStepIds: [], completedStepIds: ["analyze", "review"], failedStepIds: [], createdAt: "2026-08-03T01:00:00Z", updatedAt: "2026-08-03T01:02:00Z" },
  },
  stepRuns: {
    "step-run:analyze": { id: "step-run:analyze", flowRunId: "run:active", stepId: "analyze", actorId: "agent:claude", phase: "running" },
    "step-run:review": { id: "step-run:review", flowRunId: "run:active", stepId: "review", actorId: "human:owner", phase: "queued" },
  },
  stepResults: {
    result: { id: "result", stepRunId: "step-run:analyze", artifacts: [{ artifactId: "artifact:report", summary: "Daily report", uri: "workspace://report.md" }] },
  },
  permissionLeases: {
    lease: { id: "lease", actorId: "agent:claude", flowRunId: "run:active", capabilities: ["repository-read"], status: "active" },
  },
};

describe("living graph projection", () => {
  it("places organization, flow, run, artifact, and permission facts in one model", () => {
    const model = buildLivingGraph(input);
    const kinds = new Set(model.nodes.map((node) => node.kind));
    expect(kinds).toEqual(expect.objectContaining(new Set(["actor", "flow", "run", "artifact", "capability"])));
    expect(model.nodes.some((node) => node.id === "run:active")).toBe(true);
    expect(model.nodes.some((node) => node.id === "run:complete")).toBe(false);
    expect(model.nodes.some((node) => node.id === "run-stack:flow:daily" && node.label === "1 historical runs")).toBe(true);
    expect(model.edges.some((edge) => edge.type === "authorization")).toBe(true);
    expect(model.nodes.filter((node) => node.kind === "flow")).toHaveLength(1);
  });

  it("keeps historical runs reachable when their stack is expanded", () => {
    const model = buildLivingGraph(input, new Set(["flow:daily"]));
    expect(model.nodes.some((node) => node.id === "run:complete")).toBe(true);
  });

  it("keeps existing positions stable when a new runtime fact arrives", () => {
    const first = layoutLivingGraph(buildLivingGraph(input));
    const nextInput = structuredClone(input);
    nextInput.graph.nodes.push({ id: "agent:new", name: "New agent", type: "actor", kind: "agent", status: "online" });
    const second = layoutLivingGraph(buildLivingGraph(nextInput), positionSnapshot(first));
    for (const id of ["human:owner", "agent:claude", "flow-step:flow:daily:analyze", "artifact:report"]) {
      const before = first.nodes.find((node) => node.id === id);
      const after = second.nodes.find((node) => node.id === id);
      expect({ x: after?.x, y: after?.y }).toEqual({ x: before?.x, y: before?.y });
    }
  });

  it("computes a one-hop focus without hiding the rest of the graph", () => {
    const model = buildLivingGraph(input);
    const neighborhood = oneHopNeighborhood(model, "agent:claude");
    expect(neighborhood.has("agent:claude")).toBe(true);
    expect(neighborhood.has("artifact:spec")).toBe(true);
    expect(neighborhood.has("cap:read")).toBe(true);
    expect(model.nodes.length).toBeGreaterThan(neighborhood.size);
  });

  it("reserves header space and keeps every node inside the graph canvas", () => {
    const graph = layoutLivingGraph(buildLivingGraph(input));
    const flow = graph.nodes.find((node) => node.kind === "flow")!;
    const run = graph.nodes.find((node) => node.kind === "run")!;
    const flowSteps = graph.nodes.filter((node) => node.parentId === flow.id && node.kind === "step");
    const runSteps = graph.nodes.filter((node) => node.parentId === run.id && node.kind === "step");
    expect(flow.height).toBeLessThan(606);
    expect(flowSteps.every((node) => node.y! >= flow.y! + 72)).toBe(true);
    expect(runSteps.every((node) => node.y! >= run.y! + 72)).toBe(true);
    expect(graph.nodes.every((node) => node.x! >= 0 && node.x! + node.width! <= graph.width)).toBe(true);
  });
});
