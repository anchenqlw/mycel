import { createHash } from "node:crypto";
import type { PermissionLease, Task, WorkerSpecVersion } from "@mycel/domain";

export interface WorkspaceSnapshot {
  id: string;
  realPath: string;
  revision?: string;
}

export interface RenderedWorkerHarness {
  checksum: string;
  systemPrompt: string;
  allowedTools: string[];
  mcpServers: Array<{
    name: string;
    transport: "stdio" | "http";
    command?: string;
    args: string[];
    url?: string;
    env: Record<string, { secretRef: string } | { value: string }>;
    allowedTools: string[];
  }>;
  model?: string;
  effort?: string;
  maxTurns: number;
  timeoutMs: number;
  maxBudgetUsd: number;
}

export function renderWorkerHarness(input: {
  spec: WorkerSpecVersion;
  task?: Task;
  instruction: string;
  workspace: WorkspaceSnapshot;
  permissionLease?: PermissionLease;
  upstreamSummaries?: string[];
}): RenderedWorkerHarness {
  const permissions = new Set(input.permissionLease?.capabilities ?? input.spec.tools.map((tool) => permissionCapability(tool.permission)));
  const tools = input.spec.tools
    .filter((tool) => tool.enabled && permissions.has(permissionCapability(tool.permission)))
    .map((tool) => tool.name)
    .sort();
  const skills = input.spec.skills.filter((skill) => skill.enabled).sort((left, right) => left.name.localeCompare(right.name));
  const mcpServers = input.spec.mcpServers.filter((server) => server.enabled).sort((left, right) => left.name.localeCompare(right.name)).map((server) => ({
    name: server.name,
    transport: server.transport,
    ...(server.command ? { command: server.command } : {}),
    args: [...server.args],
    ...(server.url ? { url: server.url } : {}),
    env: Object.fromEntries(Object.entries(server.env).sort(([left], [right]) => left.localeCompare(right))),
    allowedTools: [...server.allowedTools].sort(),
  }));
  const systemPrompt = [
    input.spec.systemPrompt,
    skills.length ? ["## Skills", ...skills.map((skill) => `### ${skill.name}\n${skill.content}`)].join("\n") : "",
    `## Assigned scope\nWorkspace: ${input.workspace.id}\nPermission ceiling: ${[...permissions].sort().join(", ") || "none"}`,
    input.task ? `Task: ${input.task.title}\nAcceptance criteria:\n${input.task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}` : "",
    input.upstreamSummaries?.length ? `## Upstream results\n${input.upstreamSummaries.map((item) => `- ${item}`).join("\n")}` : "",
    input.spec.orchestration.enabled
      ? `You may coordinate bounded Workers up to depth ${input.spec.orchestration.maxDelegationDepth} and fan-out ${input.spec.orchestration.maxFanOut}.`
      : "You may not create or delegate to additional Workers.",
    "Work only within the assigned Task, Workspace, and permission ceiling. Return a concise result and evidence references.",
  ].filter(Boolean).join("\n\n");
  const output = {
    systemPrompt,
    allowedTools: tools,
    mcpServers,
    ...(input.spec.engine.model ? { model: input.spec.engine.model } : {}),
    ...(input.spec.engine.effort ? { effort: input.spec.engine.effort } : {}),
    maxTurns: input.spec.sessionPolicy.maxTurns,
    timeoutMs: input.spec.sessionPolicy.timeoutMs,
    maxBudgetUsd: input.spec.budget.maxCostUsd ?? 0,
  };
  return { checksum: createHash("sha256").update(stableJson(output)).digest("hex"), ...output };
}

function permissionCapability(permission: WorkerSpecVersion["tools"][number]["permission"]): string {
  return permission === "read" ? "repository-read" : permission === "write" ? "repository-write" : permission;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
