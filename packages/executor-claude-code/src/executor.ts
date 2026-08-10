import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExecutorPort, ExecutorPrepareInput, ExecutorProgress, ExecutorResult } from "@mycel/application";
import { ExecutionContractSchema, type Evidence, type ExecutionContract } from "@mycel/domain";
import { parseClaudeStream } from "./claude-stream.js";
import { runChecked, runCommand, startCommand, type RunningCommand } from "./process.js";

export interface ClaudeCodeExecutorConfig {
  claudeBin: string;
  repositoryPath: string;
  dataDir: string;
  timeoutMs: number;
  maxTurns: number;
  maxBudgetUsd: number;
  model?: string;
}

export class ClaudeCodeExecutor implements ExecutorPort {
  readonly #config: ClaudeCodeExecutorConfig;
  readonly #active = new Map<string, RunningCommand>();

  constructor(config: ClaudeCodeExecutorConfig) {
    this.#config = { ...config, repositoryPath: realpathSync(config.repositoryPath), dataDir: resolve(config.dataDir) };
  }

  async prepare(input: ExecutorPrepareInput): Promise<ExecutionContract> {
    const repositoryRoot = realpathSync(
      await runChecked("git", ["rev-parse", "--show-toplevel"], { cwd: this.#config.repositoryPath }),
    );
    if (repositoryRoot !== this.#config.repositoryPath) {
      throw new Error(`configured workspace must be the Git root: ${repositoryRoot}`);
    }
    const baselineCommit = await runChecked("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
    const worktreeRoot = join(this.#config.dataDir, "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
    const worktreePath = join(worktreeRoot, safeSegment(input.runId));
    const branchName = `mycel/${safeSegment(input.runId)}`;
    await runChecked("git", ["worktree", "add", "-b", branchName, worktreePath, baselineCommit], {
      cwd: repositoryRoot,
      timeoutMs: 60_000,
    });

    return ExecutionContractSchema.parse({
      runId: input.runId,
      workId: input.work.id,
      executorActorId: input.executorActorId,
      ownerActorId: input.ownerActorId,
      acceptorActorId: input.acceptorActorId,
      repositoryId: input.repositoryId,
      baselineCommit,
      worktreePath,
      task: input.work.description,
      acceptanceCriteria: input.work.acceptanceCriteria,
      allowedTools: ["Read", "Glob", "Grep", "Edit", "Write"],
      testCommandArgv: input.testCommandArgv,
      timeoutMs: this.#config.timeoutMs,
      maxTurns: this.#config.maxTurns,
      maxBudgetUsd: this.#config.maxBudgetUsd,
      requiredEvidence: ["patch", "test-report", "execution-summary"],
    });
  }

  async execute(
    contract: ExecutionContract,
    onProgress: (progress: ExecutorProgress) => Promise<void>,
  ): Promise<ExecutorResult> {
    const args = [
      "--safe-mode",
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--effort", "low",
      "--model", this.#config.model ?? "sonnet",
      "--permission-mode", "acceptEdits",
      "--tools", contract.allowedTools.join(","),
      "--allowedTools", contract.allowedTools.join(","),
      "--max-turns", String(contract.maxTurns),
      "--max-budget-usd", String(contract.maxBudgetUsd),
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      executorPrompt(contract),
    ];
    let incompleteLine = "";
    let progressChain = Promise.resolve();
    const running = startCommand(this.#config.claudeBin, args, {
      cwd: contract.worktreePath,
      timeoutMs: contract.timeoutMs,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      onStdoutChunk: (chunk) => {
        const combined = incompleteLine + chunk;
        const lines = combined.split(/\r?\n/);
        incompleteLine = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = parseClaudeStream(line);
          for (const progress of parsed.progress) {
            progressChain = progressChain.then(() => onProgress(progress));
          }
        }
      },
    });
    this.#active.set(contract.runId, running);
    const commandResult = await running.result.finally(() => this.#active.delete(contract.runId));
    await progressChain;
    const claude = parseClaudeStream(commandResult.stdout);

    await onProgress({ stage: "testing", message: `Running ${contract.testCommandArgv.join(" ")}` });
    const [testExecutable, ...testArgs] = contract.testCommandArgv;
    if (!testExecutable) throw new Error("test command is empty");
    const test = await runCommand(testExecutable, testArgs, {
      cwd: contract.worktreePath,
      timeoutMs: Math.min(contract.timeoutMs, 300_000),
    });
    const patch = await runChecked("git", ["diff", "--binary", contract.baselineCommit, "--"], {
      cwd: contract.worktreePath,
    });
    const diffStat = await runChecked("git", ["diff", "--stat", contract.baselineCommit, "--"], {
      cwd: contract.worktreePath,
    });
    const artifactsDirectory = join(this.#config.dataDir, "artifacts", safeSegment(contract.runId));
    mkdirSync(artifactsDirectory, { recursive: true });
    const patchPath = join(artifactsDirectory, "changes.patch");
    const testPath = join(artifactsDirectory, "test-output.txt");
    const summaryPath = join(artifactsDirectory, "execution-summary.json");
    const testOutput = `${test.stdout}${test.stderr ? `\n[stderr]\n${test.stderr}` : ""}`;
    const structuredSummary = {
      runId: contract.runId,
      sessionId: claude.sessionId,
      result: claude.resultText,
      diffStat,
      exitCode: commandResult.exitCode,
      testExitCode: test.exitCode,
      timedOut: commandResult.timedOut,
      knownLimitations: [],
    };
    writeFileSync(patchPath, patch, "utf8");
    writeFileSync(testPath, testOutput, "utf8");
    writeFileSync(summaryPath, JSON.stringify(structuredSummary, null, 2), "utf8");

    const evidence: Evidence[] = [
      artifact(contract, "patch", patchPath, "text/x-diff", diffStat || "No file changes"),
      { ...artifact(contract, "test-report", testPath, "text/plain", `Test exit code ${test.exitCode}`), passed: test.exitCode === 0 },
      artifact(contract, "execution-summary", summaryPath, "application/json", claude.resultText || "Claude Code execution summary"),
    ];
    const success = commandResult.exitCode === 0 && !commandResult.timedOut && !claude.isError && test.exitCode === 0 && patch.length > 0;
    return {
      success,
      exitCode: commandResult.exitCode,
      summary: success
        ? claude.resultText || "Claude Code completed and tests passed"
        : failureSummary(commandResult, claude.isError, test.exitCode, patch),
      ...(claude.sessionId !== undefined ? { sessionId: claude.sessionId } : {}),
      durationMs: commandResult.durationMs + test.durationMs,
      ...(claude.costUsd !== undefined ? { costUsd: claude.costUsd } : {}),
      evidence,
      ...(!success ? { error: commandResult.stderr || test.stderr || "Execution contract was not satisfied" } : {}),
    };
  }

  async cancel(runId: string): Promise<boolean> {
    const running = this.#active.get(runId);
    if (!running) return false;
    running.child.kill("SIGINT");
    setTimeout(() => running.child.kill("SIGKILL"), 5_000).unref();
    return true;
  }
}

function executorPrompt(contract: ExecutionContract): string {
  return [
    "You are the adopted Claude Code executor for a Mycel Work.",
    `Task: ${contract.task}`,
    "Acceptance criteria:",
    ...contract.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "Edit only files needed for the task. Do not edit tests merely to make them pass.",
    "Do not commit, merge, push, install dependencies, access the network, or change permissions.",
    "The host will run the configured test command after you exit.",
    "Finish with a concise summary of changed files, behavior, and known limitations.",
  ].join("\n");
}

function artifact(
  contract: ExecutionContract,
  kind: Evidence["kind"],
  uri: string,
  mediaType: string,
  summary: string,
): Evidence {
  return {
    artifactId: `artifact:${contract.runId}:${kind}`,
    runId: contract.runId,
    workId: contract.workId,
    kind,
    uri,
    sha256: createHash("sha256").update(readFileSync(uri)).digest("hex"),
    mediaType,
    summary,
  };
}

function safeSegment(value: string): string {
  return basename(value.replace(/[^a-zA-Z0-9._-]/g, "-")).slice(0, 80);
}

function failureSummary(
  command: { exitCode: number | null; timedOut: boolean },
  claudeError: boolean,
  testExitCode: number | null,
  patch: string,
): string {
  if (command.timedOut) return "Claude Code timed out";
  if (command.exitCode !== 0 || claudeError) return "Claude Code exited with an error";
  if (!patch) return "Claude Code produced no code changes";
  if (testExitCode !== 0) return "Claude Code changed the repository but tests failed";
  return "Execution contract was not satisfied";
}
