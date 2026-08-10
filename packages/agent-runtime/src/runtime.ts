import { randomUUID } from "node:crypto";
import type { AgentAdapterKind, WorkerControlCapabilities } from "@mycel/domain";
import { parseClaudeStream, runCommand, startCommand, type RunningCommand } from "@mycel/executor-claude-code";

export interface AgentProbeResult {
  adapterKind: Extract<AgentAdapterKind, "claude-code" | "codex">;
  executable: string;
  available: boolean;
  authState: "authenticated" | "unauthenticated" | "unknown";
  version?: string;
  capabilities: string[];
  controlCapabilities: WorkerControlCapabilities;
  error?: string;
}

export interface AgentRunInput {
  sessionId: string;
  cwd: string;
  prompt: string;
  mode: "explore" | "execute";
  systemPrompt?: string;
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  providerSessionId?: string;
  forkSession?: boolean;
  allowedTools?: string[];
  effort?: string;
  mcpConfigPath?: string;
}

export interface NormalizedAgentEvent {
  phase: "started" | "progress" | "tool" | "permission" | "blocked" | "completed" | "failed";
  stage: string;
  message: string;
  nativeType?: string;
  occurredAt: string;
}

export interface AgentRunResult {
  success: boolean;
  exitCode: number | null;
  providerSessionId?: string;
  summary: string;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface AgentAdapter {
  readonly kind: Extract<AgentAdapterKind, "claude-code" | "codex">;
  probe(cwd: string): Promise<AgentProbeResult>;
  run(input: AgentRunInput, onEvent: (event: NormalizedAgentEvent) => Promise<void>): Promise<AgentRunResult>;
  cancel(sessionId: string): boolean;
}

abstract class ProcessAdapter implements AgentAdapter {
  abstract readonly kind: Extract<AgentAdapterKind, "claude-code" | "codex">;
  readonly active = new Map<string, RunningCommand>();

  abstract probe(cwd: string): Promise<AgentProbeResult>;
  abstract run(input: AgentRunInput, onEvent: (event: NormalizedAgentEvent) => Promise<void>): Promise<AgentRunResult>;

  cancel(sessionId: string): boolean {
    const running = this.active.get(sessionId);
    if (!running) return false;
    running.child.kill("SIGINT");
    setTimeout(() => running.child.kill("SIGKILL"), 5_000).unref();
    return true;
  }
}

export class ClaudeCodeAgentAdapter extends ProcessAdapter {
  readonly kind = "claude-code" as const;

  constructor(private readonly executable = "claude") { super(); }

  async probe(cwd: string): Promise<AgentProbeResult> {
    return probeExecutable(this.kind, this.executable, cwd, ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "session-resume", "structured-output"]);
  }

  async run(input: AgentRunInput, onEvent: (event: NormalizedAgentEvent) => Promise<void>): Promise<AgentRunResult> {
    const providerSessionId = input.providerSessionId ?? randomUUID();
    const tools = (input.allowedTools?.length ? input.allowedTools : input.mode === "explore" ? ["Read", "Glob", "Grep", "Bash"] : ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]).join(",");
    const args = [
      "--safe-mode", "--print", "--output-format", "stream-json", "--verbose",
      "--permission-mode", input.mode === "explore" ? "plan" : "acceptEdits",
      "--tools", tools,
      "--max-turns", String(input.maxTurns),
      "--max-budget-usd", String(input.maxBudgetUsd),
      ...(input.providerSessionId ? ["--resume", input.providerSessionId, ...(input.forkSession ? ["--fork-session"] : [])] : ["--session-id", providerSessionId]),
      "--disable-slash-commands", "--no-chrome",
      ...(input.model ? ["--model", input.model] : []),
      ...(input.effort ? ["--effort", input.effort] : []),
      ...(input.mcpConfigPath ? ["--strict-mcp-config", "--mcp-config", input.mcpConfigPath] : []),
      ...(input.systemPrompt ? ["--system-prompt", input.systemPrompt] : []),
      input.prompt,
    ];
    await onEvent(event("started", "claude", "Claude Code session started"));
    let incomplete = "";
    let chain = Promise.resolve();
    const running = startCommand(this.executable, args, {
      cwd: input.cwd,
      timeoutMs: 30 * 60_000,
      onStdoutChunk: (chunk) => {
        const lines = `${incomplete}${chunk}`.split(/\r?\n/);
        incomplete = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = parseClaudeStream(line);
          for (const progress of parsed.progress) {
            chain = chain.then(() => onEvent(event("progress", progress.stage, progress.message, "claude-stream")));
          }
        }
      },
    });
    this.active.set(input.sessionId, running);
    const result = await running.result.finally(() => this.active.delete(input.sessionId));
    await chain;
    const parsed = parseClaudeStream(result.stdout);
    const success = result.exitCode === 0 && !result.timedOut && !parsed.isError;
    const summary = parsed.resultText || result.stderr.trim() || (success ? "Claude Code completed" : "Claude Code failed");
    await onEvent(event(success ? "completed" : "failed", "claude", summary));
    return { success, exitCode: result.exitCode, providerSessionId: parsed.sessionId ?? providerSessionId, summary, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs };
  }
}

export class CodexAgentAdapter extends ProcessAdapter {
  readonly kind = "codex" as const;

  constructor(private readonly executable = "codex") { super(); }

  async probe(cwd: string): Promise<AgentProbeResult> {
    return probeExecutable(this.kind, this.executable, cwd, ["read-only", "workspace-write", "json-events", "session-resume", "output-schema"]);
  }

  async run(input: AgentRunInput, onEvent: (event: NormalizedAgentEvent) => Promise<void>): Promise<AgentRunResult> {
    const prompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
    const args = input.providerSessionId
      ? ["exec", "resume", "--json", ...(input.model ? ["--model", input.model] : []), input.providerSessionId, prompt]
      : ["exec", "--json", "--color", "never", "--cd", input.cwd, "--sandbox", input.mode === "explore" ? "read-only" : "workspace-write", ...(input.model ? ["--model", input.model] : []), prompt];
    await onEvent(event("started", "codex", "Codex session started"));
    let incomplete = "";
    let providerSessionId: string | undefined;
    let lastMessage = "";
    let chain = Promise.resolve();
    const running = startCommand(this.executable, args, {
      cwd: input.cwd,
      timeoutMs: 30 * 60_000,
      onStdoutChunk: (chunk) => {
        const lines = `${incomplete}${chunk}`.split(/\r?\n/);
        incomplete = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const item = JSON.parse(line) as Record<string, unknown>;
            const nativeType = String(item.type ?? "codex-event");
            providerSessionId = typeof item.thread_id === "string" ? item.thread_id : providerSessionId;
            lastMessage = extractCodexMessage(item) || lastMessage;
            chain = chain.then(() => onEvent(event("progress", nativeType, lastMessage || nativeType, nativeType)));
          } catch {
            lastMessage = line.trim();
          }
        }
      },
    });
    this.active.set(input.sessionId, running);
    const result = await running.result.finally(() => this.active.delete(input.sessionId));
    await chain;
    const success = result.exitCode === 0 && !result.timedOut;
    const summary = lastMessage || result.stderr.trim() || (success ? "Codex completed" : "Codex failed");
    await onEvent(event(success ? "completed" : "failed", "codex", summary));
    return { success, exitCode: result.exitCode, ...(providerSessionId ? { providerSessionId } : {}), summary, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs };
  }
}

export class LocalAgentRuntime {
  readonly #adapters: Map<string, AgentAdapter>;

  constructor(adapters: AgentAdapter[] = [new ClaudeCodeAgentAdapter(), new CodexAgentAdapter()]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  async probeAll(cwd: string): Promise<AgentProbeResult[]> {
    return Promise.all([...this.#adapters.values()].map((adapter) => adapter.probe(cwd)));
  }

  run(kind: AgentAdapterKind, input: AgentRunInput, onEvent: (event: NormalizedAgentEvent) => Promise<void>): Promise<AgentRunResult> {
    const adapter = this.#adapters.get(kind);
    if (!adapter) throw new Error(`agent adapter is not locally runnable: ${kind}`);
    return adapter.run(input, onEvent);
  }

  cancel(kind: AgentAdapterKind, sessionId: string): boolean {
    return this.#adapters.get(kind)?.cancel(sessionId) ?? false;
  }
}

async function probeExecutable(
  adapterKind: "claude-code" | "codex",
  executable: string,
  cwd: string,
  capabilities: string[],
): Promise<AgentProbeResult> {
  const controlCapabilities = controlCapabilitiesForAdapter(adapterKind);
  try {
    const located = await runCommand("which", [executable], { cwd, timeoutMs: 5_000 });
    const resolvedExecutable = located.exitCode === 0 && located.stdout.trim() ? located.stdout.trim() : executable;
    const result = await runCommand(resolvedExecutable, ["--version"], { cwd, timeoutMs: 10_000 });
    if (result.exitCode !== 0) {
      return { adapterKind, executable: resolvedExecutable, available: false, authState: "unknown", capabilities, controlCapabilities, error: result.stderr.trim() || `exit code ${result.exitCode}` };
    }
    const authArgs = adapterKind === "claude-code" ? ["auth", "status"] : ["login", "status"];
    const auth = await runCommand(resolvedExecutable, authArgs, { cwd, timeoutMs: 10_000 });
    const authenticated = auth.exitCode === 0;
    return {
      adapterKind,
      executable: resolvedExecutable,
      available: authenticated,
      authState: authenticated ? "authenticated" : "unauthenticated",
      version: result.stdout.trim() || result.stderr.trim(),
      capabilities,
      controlCapabilities,
      ...(!authenticated ? { error: "CLI 已安装，但尚未登录" } : {}),
    };
  } catch (error) {
    return { adapterKind, executable, available: false, authState: "unknown", capabilities, controlCapabilities, error: error instanceof Error ? error.message : String(error) };
  }
}

export function controlCapabilitiesForAdapter(adapterKind: "claude-code" | "codex"): WorkerControlCapabilities {
  return adapterKind === "claude-code"
    ? { send: true, interrupt: true, resume: true, cancel: true, fork: true, structuredOutput: true }
    : { send: true, interrupt: true, resume: true, cancel: true, fork: false, structuredOutput: true };
}

function event(
  phase: NormalizedAgentEvent["phase"],
  stage: string,
  message: string,
  nativeType?: string,
): NormalizedAgentEvent {
  return { phase, stage, message, ...(nativeType ? { nativeType } : {}), occurredAt: new Date().toISOString() };
}

function extractCodexMessage(item: Record<string, unknown>): string {
  if (typeof item.message === "string") return item.message;
  if (typeof item.text === "string") return item.text;
  const nested = item.item;
  if (nested && typeof nested === "object") {
    const record = nested as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.command === "string") return record.command;
  }
  return "";
}
