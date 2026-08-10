import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphNode } from "@mycel/domain";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeExecutor } from "./executor.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ClaudeCodeExecutor.prepare", () => {
  it("creates an isolated branch and worktree at the baseline commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "mycel-executor-"));
    directories.push(root);
    const repositoryPath = join(root, "repository");
    const dataDir = join(root, "data");
    execFileSync("mkdir", [repositoryPath]);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
    execFileSync("git", ["config", "user.name", "Mycel Test"], { cwd: repositoryPath });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repositoryPath });
    writeFileSync(join(repositoryPath, "index.js"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repositoryPath });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repositoryPath });

    const executor = new ClaudeCodeExecutor({
      claudeBin: "claude",
      repositoryPath,
      dataDir,
      timeoutMs: 1_000,
      maxTurns: 3,
      maxBudgetUsd: 1,
    });
    const now = new Date().toISOString();
    const work = {
      id: "work:test",
      name: "Test worktree",
      type: "work",
      kind: "run",
      description: "Change the value",
      status: "approved",
      acceptanceCriteria: ["tests pass"],
      risk: "red",
      createdAt: now,
      updatedAt: now,
    } satisfies Extract<GraphNode, { type: "work" }>;
    const contract = await executor.prepare({
      runId: "run:test",
      work,
      executorActorId: "agent:claude",
      ownerActorId: "human:owner",
      acceptorActorId: "human:owner",
      repositoryId: "repo:test",
      testCommandArgv: ["npm", "test"],
    });

    expect(existsSync(join(contract.worktreePath, "index.js"))).toBe(true);
    expect(contract.worktreePath).not.toBe(repositoryPath);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: contract.worktreePath, encoding: "utf8" }).trim()).toBe("mycel/run-test");
    expect(contract.baselineCommit).toMatch(/^[a-f0-9]{40}$/);
  });
});
