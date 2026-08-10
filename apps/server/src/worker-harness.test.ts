import { describe, expect, it } from "vitest";
import { renderWorkerHarness } from "./worker-harness.js";
import type { WorkerSpecVersion } from "@mycel/domain";

const spec: WorkerSpecVersion = {
  schemaVersion: 2, id: "spec:1", workerId: "worker:1", version: 1,
  engine: { adapter: "claude-code", model: "sonnet", effort: "medium" }, systemPrompt: "Review carefully.",
  skills: [{ name: "review", content: "Use evidence.", enabled: true, checksum: "a".repeat(64) }],
  mcpServers: [{ name: "github", transport: "http", url: "https://mcp.example.test", args: [], env: { GITHUB_TOKEN: { secretRef: "secret:github" } }, allowedTools: ["search"], enabled: true }],
  tools: [
    { name: "Read", source: "builtin", permission: "read", enabled: true },
    { name: "Write", source: "builtin", permission: "write", enabled: true },
  ],
  fileRefs: [], knowledgeRefs: [], memory: { scope: "task", resume: true, summaryPolicy: "rolling" },
  sessionPolicy: { maxTurns: 20, timeoutMs: 300_000, maxConcurrentSessions: 1 }, budget: { maxCostUsd: 2 },
  orchestration: { enabled: false, maxDelegationDepth: 0, maxFanOut: 0, allowedWorkerKinds: [] }, lifecycle: "persistent",
  createdBy: "human:owner", createdAt: "2026-08-05T00:00:00.000Z",
};

describe("renderWorkerHarness", () => {
  it("is deterministic, narrows tools, and never resolves or exposes secret values", () => {
    const input = { spec, instruction: "Review", workspace: { id: "workspace:1", realPath: "/repo" }, permissionLease: { id: "lease:1", flowRunId: "run:1", actorId: "worker:1", capabilities: ["repository-read"], workspaceScopes: ["workspace:1"], maxRuntimeMs: 300_000, maxAttempts: 1, expiresAt: "2026-08-05T01:00:00.000Z", status: "active" as const } };
    const first = renderWorkerHarness(input);
    const second = renderWorkerHarness(input);
    expect(first).toEqual(second);
    expect(first.allowedTools).toEqual(["Read"]);
    expect(JSON.stringify(first)).toContain("secret:github");
    expect(JSON.stringify(first)).not.toContain("plaintext-token");
  });
});
