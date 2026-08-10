import { resolve } from "node:path";
import type { GraphNode } from "@mycel/domain";
import { ClaudeCodeExecutor, runChecked } from "@mycel/executor-claude-code";
import { resetDemoData } from "./reset-demo.js";

const projectRoot = resolve(import.meta.dirname, "..");
const repositoryPath = resolve(projectRoot, ".local/demo-repo");
await resetDemoData({ dataDir: resolve(projectRoot, ".local/mycel"), repositoryPath }, resolve(projectRoot, ".local"));
const executor = new ClaudeCodeExecutor({
  claudeBin: process.env.MYCEL_CLAUDE_BIN ?? "claude",
  repositoryPath,
  dataDir: resolve(projectRoot, ".local/claude-smoke"),
  timeoutMs: 900_000,
  maxTurns: 12,
  maxBudgetUsd: 3,
  model: process.env.MYCEL_CLAUDE_MODEL ?? "sonnet",
});
const now = new Date().toISOString();
const work = {
  id: "work:claude-smoke",
  name: "Fix UTF-8 CSV export",
  type: "work",
  kind: "run",
  description: "Fix the CSV exporter so spreadsheet applications recognize UTF-8. Do not modify the test.",
  status: "approved",
  acceptanceCriteria: ["npm test passes", "the exported CSV begins with the UTF-8 BOM"],
  risk: "red",
  createdAt: now,
  updatedAt: now,
} satisfies Extract<GraphNode, { type: "work" }>;
const contract = await executor.prepare({
  runId: `smoke-${Date.now()}`,
  work,
  executorActorId: "agent:claude",
  ownerActorId: "human:owner",
  acceptorActorId: "human:owner",
  repositoryId: "repo:demo",
  testCommandArgv: ["npm", "test"],
});
const result = await executor.execute(contract, async (progress) => {
  console.log(`[${progress.stage}] ${progress.message}`);
});
if (!result.success) throw new Error(result.error ?? result.summary);
console.log(await runChecked("npm", ["test"], { cwd: contract.worktreePath, timeoutMs: 120_000 }));
console.log(JSON.stringify({ contract, result }, null, 2));
