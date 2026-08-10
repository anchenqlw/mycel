import { spawn, type ChildProcess } from "node:child_process";

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunningCommand {
  child: ChildProcess;
  result: Promise<CommandResult>;
}

export function startCommand(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; onStdoutChunk?: (chunk: string) => void },
): RunningCommand {
  const startedAt = Date.now();
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    options.onStdoutChunk?.(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGINT");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, options.timeoutMs);
  timeout.unref();

  const result = new Promise<CommandResult>((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });
  });
  return { child, result };
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; onStdoutChunk?: (chunk: string) => void },
): Promise<CommandResult> {
  return startCommand(executable, args, options).result;
}

export async function runChecked(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  const result = await runCommand(executable, args, { ...options, timeoutMs: options.timeoutMs ?? 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}
