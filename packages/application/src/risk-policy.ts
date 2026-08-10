import type { ChangeOperation, ControlCommand, RiskLevel } from "@mycel/domain";

const rank: Record<RiskLevel, number> = { green: 0, yellow: 1, red: 2 };

export function classifyCommandRisk(command: ControlCommand): RiskLevel {
  if (["open-resource", "pause-task", "resume-task", "cancel-task", "accept-task", "retry-task", "send-worker-session", "interrupt-worker-session", "resume-worker-session", "cancel-worker-session", "retry-worker-session", "fork-worker-session", "claim-human-task", "release-human-task", "complete-human-task"].includes(command.action)) return "green";
  if (["replace-worker", "reassign-task", "reassign-human-task", "reject-human-task", "trigger-flow", "pause-flow-run", "resume-flow-run", "cancel-flow-run", "retry-flow-run"].includes(command.action)) return "yellow";
  return "red";
}

export function classifyChangeOperationRisk(operation: ChangeOperation): RiskLevel {
  if (["publish-worker-spec", "publish-flow", "archive-worker", "archive-flow", "archive-graph-node"].includes(operation.kind)) return "red";
  if (operation.kind === "create-worker" && operation.payload.source === "native" && operation.payload.lifecycle === "persistent") return "red";
  if (addsPower(operation.payload)) return "red";
  return "yellow";
}

export function classifyChangeSetRisk(operations: ChangeOperation[]): RiskLevel {
  return operations.map(classifyChangeOperationRisk).reduce<RiskLevel>((highest, value) => rank[value] > rank[highest] ? value : highest, "green");
}

function addsPower(value: unknown, key = ""): boolean {
  if (Array.isArray(value)) return value.some((item) => addsPower(item, key));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && /write|execute|network|owner|acceptor|persistent/i.test(`${key}:${value}`);
  }
  return Object.entries(value).some(([childKey, child]) => addsPower(child, childKey));
}
