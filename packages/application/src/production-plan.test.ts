import { describe, expect, it } from "vitest";
import type { ProductionPlan } from "@mycel/domain";
import { compileProductionPlan, validateProductionPlan } from "./production-plan.js";

function plan(): ProductionPlan {
  return {
    title: "Daily review", summary: "Analyze the repository and ask the owner to approve the result.",
    actors: [
      { id: "analyst", name: "Analyst", kind: "graph-agent", engine: "claude-code", prompt: "Analyze the repository.", skills: ["analysis"], tools: ["Read", "Grep"] },
      { id: "owner", name: "Owner", kind: "human", existingActorId: "human:owner", skills: [], tools: [] },
    ],
    workspaces: [{ id: "source", workspaceId: "repository", purpose: "Source repository", access: "read" }],
    trigger: { kind: "schedule", intervalMs: 86_400_000, timeOfDay: "09:00", timezone: "Asia/Shanghai" },
    steps: [
      { id: "analyze", name: "Analyze", actorId: "analyst", prompt: "Analyze recent changes.", workspaceIds: ["source"], dependsOn: [], condition: "previous-succeeded", join: { mode: "all" }, timeoutMs: 60_000, maxAttempts: 2, requiredCapabilities: ["repository-read"] },
      { id: "review", name: "Review", actorId: "owner", prompt: "Review the analysis.", workspaceIds: [], dependsOn: ["analyze"], condition: "previous-succeeded", join: { mode: "all" }, timeoutMs: 60_000, maxAttempts: 1, requiredCapabilities: [] },
    ],
    permissionCeiling: ["repository-read"], budget: { maxRuntimeMs: 180_000, maxTotalAttempts: 3 }, acceptanceCriteria: ["Owner reviews each report"],
  };
}

describe("ProductionPlan", () => {
  it("validates semantic references and compiles only deterministic Flow relationships", () => {
    const input = plan();
    expect(validateProductionPlan(input, { actorIds: new Set(["human:owner"]), workspaceIds: new Set(["repository"]) })).toEqual([]);
    const compiled = compileProductionPlan(input, "proposal_demo", "2026-08-04T00:00:00.000Z");
    expect(compiled.flow.steps).toHaveLength(2);
    expect(compiled.flow.steps[1]?.dependsOn).toEqual(["analyze"]);
    expect(compiled.agents[0]?.spec.prompt).toBe("Analyze the repository.");
    expect(JSON.stringify(compiled)).not.toContain("configured_by");
  });

  it("rejects unknown workspace bindings and cyclic dependencies", () => {
    const input = plan();
    input.workspaces[0]!.workspaceId = "invented-repository";
    input.steps[0]!.dependsOn = ["review"];
    const codes = validateProductionPlan(input, { actorIds: new Set(["human:owner"]), workspaceIds: new Set(["repository"]) }).map((item) => item.code);
    expect(codes).toContain("UNKNOWN_WORKSPACE");
    expect(codes).toContain("DEPENDENCY_CYCLE");
  });
});
