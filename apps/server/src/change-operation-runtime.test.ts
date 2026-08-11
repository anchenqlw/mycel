import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeSet } from "@mycel/domain";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ChangeOperation runtime", () => {
  it("materializes, publishes, and projects a scheduled Human/Worker Flow without undefined resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "mycel-change-runtime-"));
    roots.push(root);
    const repositoryPath = join(root, "workspace");
    mkdirSync(repositoryPath);
    const config: ServerConfig = {
      dataDir: join(root, "data"),
      repositoryPath,
      port: 4317,
      claudeBin: "claude-not-used-by-this-test",
      testCommandArgv: ["npm", "test"],
      steward: { maxTurns: 1, timeoutMs: 1_000, maxBudgetUsd: 1 },
      executor: { maxTurns: 1, timeoutMs: 1_000, maxBudgetUsd: 1 },
      fakeConnections: false,
    };
    const runtime = await createRuntime(config);
    try {
      const now = "2026-08-10T12:00:00.000Z";
      const changeSet: ChangeSet = {
        schemaVersion: 1,
        id: "changeset:scheduled-review",
        title: "Create scheduled review",
        intentSummary: "Create a daily Human and Worker review",
        operations: [
          {
            id: "create-capability",
            kind: "create-graph-node",
            dependsOn: [],
            payload: { id: "cap:review-read", name: "Review read", type: "capability", kind: "repository-read", scope: "repository", constraints: {} },
          },
          {
            id: "authorize-reviewer",
            kind: "create-graph-edge",
            dependsOn: ["create-capability"],
            payload: { edge: { id: "edge:review-read", type: "authorization", from: "agent:claude", toRef: "create-capability", permission: "repository-read", scope: "flow:scheduled-review" } },
          },
          {
            id: "create-flow",
            kind: "create-flow",
            dependsOn: ["authorize-reviewer"],
            payload: {
              name: "Scheduled review",
              description: "Worker reviews and Owner accepts",
              workspaceId: "repository",
              trigger: { kind: "schedule", intervalMs: 86_400_000, timeOfDay: "08:30", timezone: "Asia/Shanghai" },
              permissionCeiling: ["repository-read"],
              steps: [
                { id: "review", name: "Review", actorId: "agent:claude", prompt: "Review changes", dependsOn: [], requiredCapabilities: ["repository-read"] },
                { id: "accept", name: "Accept", actorId: "human:owner", prompt: "Accept the review", dependsOn: ["review"] },
              ],
            },
          },
          { id: "publish-flow", kind: "publish-flow", dependsOn: ["create-flow"], payload: { flowRef: "create-flow" } },
        ],
        preconditions: [],
        impact: { resourcesCreated: [], resourcesModified: [], resourcesArchived: [], permissionsAdded: [], runtimeEffects: [], warnings: [] },
        aggregateRisk: "red",
        status: "draft",
        operationResults: [],
        contextVersion: 1,
        initiatedBy: "human:owner",
        sourceMessageId: "message:scheduled-review",
        idempotencyKey: "changeset:scheduled-review",
        createdAt: now,
        updatedAt: now,
      };

      const proposed = await runtime.stewardControl.proposeChangeSet(changeSet);
      expect(proposed.status).toBe("awaiting-approval");
      runtime.stewardControl.approveChangeSet(proposed.id, "human:owner");
      const applied = await runtime.stewardControl.applyChangeSet(proposed.id);

      expect(applied.status).toBe("applied");
      expect(applied.operationResults.every((result) => result.status === "applied")).toBe(true);
      const flows = runtime.control.flowEngine.list();
      expect(flows).toHaveLength(1);
      expect(flows[0]).toMatchObject({
        id: "flow:changeset:scheduled-review:create-flow",
        status: "published",
        trigger: { kind: "schedule", timeOfDay: "08:30", timezone: "Asia/Shanghai" },
      });
      expect(JSON.stringify(runtime.control.getProjection().graph)).not.toContain("undefined");
      expect(runtime.control.getProjection().graph.nodes).toContainEqual(expect.objectContaining({ id: "work:flow:flow:changeset:scheduled-review:create-flow" }));
    } finally {
      runtime.stop();
    }
  });
});
