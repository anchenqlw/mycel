import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerSecretStore, materializeMcpConfig } from "./worker-secrets.js";

describe("WorkerSecretStore", () => {
  it("stores secrets owner-only and removes materialized Session config", () => {
    const directory = mkdtempSync(join(tmpdir(), "mycel-worker-secret-"));
    const store = new WorkerSecretStore(directory);
    store.set("secret:github", "plaintext-token");
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(store.list()).toEqual(["secret:github"]);
    const materialized = materializeMcpConfig({ dataDir: directory, sessionId: "session:1", secrets: store, harness: {
      checksum: "a".repeat(64), systemPrompt: "", allowedTools: [], model: "sonnet", maxTurns: 1, timeoutMs: 1000, maxBudgetUsd: 1,
      mcpServers: [{ name: "github", transport: "http", url: "https://mcp.example.test", args: [], env: { GITHUB_TOKEN: { secretRef: "secret:github" } }, allowedTools: [] }],
    } });
    expect(readFileSync(materialized.path!, "utf8")).toContain("plaintext-token");
    materialized.cleanup();
    expect(() => readFileSync(materialized.path!, "utf8")).toThrow();
  });
});
