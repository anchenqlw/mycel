import type { GraphNode, RiskLevel, WeaveDiff, WeaveOperation } from "./schemas.js";

const rank: Record<RiskLevel, number> = { green: 0, yellow: 1, red: 2 };

function riskForNode(node: GraphNode): RiskLevel {
  if (node.type === "actor" && node.kind === "human") return "red";
  if (node.type === "capability" && node.kind === "repository-write") return "red";
  return "green";
}

export function classifyOperation(operation: WeaveOperation): RiskLevel {
  switch (operation.op) {
    case "add_node":
      return riskForNode(operation.node);
    case "update_node": {
      const keys = Object.keys(operation.patch);
      if (keys.includes("acceptanceCriteria") || keys.includes("constraints") || keys.includes("scope")) return "red";
      if (keys.includes("executorActorId") || keys.includes("dependencies")) return "yellow";
      return "green";
    }
    case "add_edge":
      if (operation.edge.type === "authorization") return "red";
      if (operation.edge.type === "assignment") {
        return operation.edge.role === "executor" ? "yellow" : "red";
      }
      if (
        operation.edge.type === "depends_on"
        || operation.edge.type === "contains"
        || operation.edge.type === "delegation"
        || operation.edge.type === "equipped_with"
        || operation.edge.type === "configured_by"
      ) return "yellow";
      return "green";
    case "remove_edge":
      if (operation.edgeType === "authorization") return "red";
      if (
        operation.edgeType === "assignment"
        || operation.edgeType === "depends_on"
        || operation.edgeType === "contains"
        || operation.edgeType === "delegation"
        || operation.edgeType === "equipped_with"
        || operation.edgeType === "configured_by"
      ) {
        return "yellow";
      }
      return "green";
  }
}

export function classifyDiff(diff: WeaveDiff): { aggregate: RiskLevel; operations: Record<string, RiskLevel> } {
  const operations: Record<string, RiskLevel> = {};
  let aggregate: RiskLevel = "green";
  for (const operation of diff.operations) {
    const risk = classifyOperation(operation);
    operations[operation.operationId] = risk;
    if (rank[risk] > rank[aggregate]) aggregate = risk;
  }
  return { aggregate, operations };
}
