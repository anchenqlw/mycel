import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { StewardPlanInput, StewardPort } from "@mycel/application";
import { ControlResourceReferenceSchema, HarnessIntentSchema, ProductionPlanSchema, StewardChangeSetDraftSchema, StewardCommandDraftSchema, type HarnessIntent, type PlanDiagnostic } from "@mycel/domain";
import { runCommand } from "@mycel/executor-claude-code";
import { z } from "zod";

export interface ClaudeStewardConfig {
  claudeBin: string;
  repositoryPath: string;
  timeoutMs: number;
  maxTurns: number;
  maxBudgetUsd: number;
  model?: string;
}

interface ClaudeJsonResult { is_error?: boolean; result?: string; structured_output?: unknown }
interface ClaudeStreamEvent { type?: string; subtype?: string; is_error?: boolean; result?: string; structured_output?: unknown; message?: { content?: Array<{ type?: string; name?: string }> } }

const ClaudeStewardResultEnvelopeSchema = z.object({
  kind: z.enum(["answer", "clarification", "proposal", "resource", "command", "changeset"]),
  text: z.string().min(1),
  reasoningSummary: z.string().min(1),
  design: z.object({ summary: z.string().min(1), decisions: z.array(z.string()).default([]), openQuestion: z.string().min(1) }).optional(),
  plan: ProductionPlanSchema.optional(),
  designSummary: z.string().optional(),
  resource: ControlResourceReferenceSchema.optional(),
  command: StewardCommandDraftSchema.optional(),
  changeSet: StewardChangeSetDraftSchema.optional(),
});

export class ClaudeSteward implements StewardPort {
  readonly #config: ClaudeStewardConfig;
  constructor(config: ClaudeStewardConfig) { this.#config = { ...config, repositoryPath: realpathSync(config.repositoryPath) }; }

  async respond(input: StewardPlanInput, onProgress?: (phase: "inspecting-resources") => void | Promise<void>): Promise<HarnessIntent> { return this.#invoke(stewardPrompt(input), input.workspacePath, onProgress); }

  async repair(input: StewardPlanInput, diagnostics: PlanDiagnostic[], previous: HarnessIntent, onProgress?: (phase: "inspecting-resources") => void | Promise<void>): Promise<HarnessIntent> {
    return this.#invoke([
      stewardPrompt(input),
      "\nYour previous structured response failed deterministic preflight.",
      `Diagnostics: ${JSON.stringify(diagnostics)}`,
      `Previous response: ${JSON.stringify(previous)}`,
      "Repair the response exactly once. Return the corrected intent kind with a fully valid typed payload when all diagnostics can be resolved from known context; otherwise return one clarification question and do not guess.",
    ].join("\n"), input.workspacePath, onProgress);
  }

  async #invoke(prompt: string, cwd: string, onProgress?: (phase: "inspecting-resources") => void | Promise<void>): Promise<HarnessIntent> {
    let buffered = "";
    let inspectionReported = false;
    const result = await runCommand(this.#config.claudeBin, [
      "--safe-mode", "--print", "--verbose", "--output-format", "stream-json", "--json-schema", JSON.stringify(claudeJsonSchema()),
      "--effort", "medium", "--model", this.#config.model ?? "sonnet", "--permission-mode", "plan",
      "--tools", "Read,Glob,Grep,Bash", "--allowedTools", inspectionTools(), "--max-turns", String(this.#config.maxTurns),
      "--max-budget-usd", String(this.#config.maxBudgetUsd), "--disable-slash-commands", "--no-chrome", "--no-session-persistence", prompt,
    ], { cwd, timeoutMs: this.#config.timeoutMs, onStdoutChunk: (chunk) => {
      if (inspectionReported) return;
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseStreamLine(line);
        if (event && usesInspectionTool(event)) {
          inspectionReported = true;
          void onProgress?.("inspecting-resources");
          break;
        }
      }
    } });
    if (result.exitCode !== 0) throw new Error(`Steward Claude Code failed: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`}`);
    const envelope = parseStreamEnvelope(result.stdout);
    if (envelope.is_error) throw new Error(`Steward Claude Code returned an error: ${envelope.result ?? "unknown"}`);
    return HarnessIntentSchema.parse(envelope.structured_output ?? parseResultObject(envelope.result));
  }
}

export function claudeJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ClaudeStewardResultEnvelopeSchema, { target: "draft-7" }) as Record<string, unknown>;
}

export function stewardPrompt(input: StewardPlanInput): string {
  return [
    "You are Mycel Steward, the conversational control surface for a living production graph.",
    "Choose exactly one intent from answer, clarification, resource, command, or changeset. You own this judgment; there is no keyword router.",
    "answer: satisfy a simple/read-only request directly. Never create a proposal merely to inspect, report, explain, summarize, or browse.",
    "clarification: ask exactly one material question when a durable production relationship cannot be specified safely. Include design state when brainstorming.",
    "resource: point to one exact existing Worker, WorkerSpec, Flow, Flow Run, Task, Worker Session, Human Task, Workspace, file, evidence, history view, or graph object.",
    "command: control an existing exact runtime object. Never invent target IDs. Use it for start/pause/resume/cancel/retry/accept/reassign, Worker Session send/interrupt/resume/cancel/retry/fork/replace, Flow triggers, Human Task actions, and opening resources.",
    "changeset: use for every durable definition or production-relationship change, including creating or modifying Workers, WorkerSpecs, Flows, Tasks, and Graph nodes or edges. Return typed operations and preconditions; the Control Plane computes impact, risk, approval, IDs, timestamps, and execution status.",
    "proposal is a legacy compatibility format. Do not choose it for new requests; use changeset.",
    "Do not edit files, install dependencies, execute the requested change, or perform network operations in this Steward turn.",
    "Use the built-in production graph brainstorm skill below for complex graph requests.",
    builtinSkill(),
    `User request: ${input.text}`,
    `Recent conversation: ${JSON.stringify(input.history)}`,
    `Active design session: ${JSON.stringify(input.designSession ?? null)}`,
    `Known resources: ${JSON.stringify(input.resources ?? { actors: [], flows: [], runs: [], workspaces: [{ id: "repository", name: input.repositoryId }] })}`,
    `Current typed graph: ${JSON.stringify(input.graph)}`,
    `Configured workspace binding: ${input.workspaceId} (${input.workspaceName})`,
    `Local IANA timezone: ${input.localTimezone}`,
    `Originator Actor: ${input.originatorActorId}`,
    "Use Worker as the machine-executor term. Existing local/external executors are Adopted Workers; Mycel-created executors are Native Workers.",
    "For a command or changeset precondition, copy target resource IDs and versions exactly from Known resources. If there are multiple plausible targets, ask one clarification question instead of guessing.",
    "The living production graph is a singleton with canonical ID graph:main. Use graph:main in Graph preconditions; never emit graph:current.",
    "A WorkerSpec is immutable. Harness edits publish a new WorkerSpec version and never mutate a running Session. Secrets are SecretRef values only; never request or emit plaintext credentials in a changeset.",
    "ChangeSet payload contracts are exact. create-worker payload is {name, spec}, where spec contains engine:{adapter,model?,effort?}, systemPrompt, skills:[{name,description?,content,enabled,checksum}], mcpServers, tools:[{name,source,permission,enabled,config?}], fileRefs, knowledgeRefs, memory:{scope,resume,summaryPolicy}, sessionPolicy:{maxTurns,timeoutMs,maxConcurrentSessions}, budget:{maxCostUsd?,maxTokens?}, orchestration:{enabled,maxDelegationDepth,maxFanOut,allowedWorkerKinds}, lifecycle, createdBy. publish-worker-spec uses targetId of an existing Worker and payload {spec} with the same spec body. Never emit schemaVersion, IDs, version, or timestamps inside spec; the Control Plane owns them.",
    "create-worker automatically materializes the Worker node, immutable WorkerSpec artifact, and configured_by edge. Do not add duplicate Graph operations for those facts. Add explicit create-graph-edge operations only for additional production relationships; payload is {edge:{id,type,from,to,role?,permission?,scope?,subgraphId?,condition?}} and every endpoint must already exist or reference a prior operation with fromRef/toRef.",
    "create-graph-node payload is {node} using a typed Actor, Work, Artifact, or Capability node. update-graph-node payload is {patch}. remove-graph-edge targets an existing edge ID. create-task payload must include title, description, source as {kind:'conversation',conversationId:<current conversation>} or {kind:'flow',flowId,flowRunId,stepId} or {kind:'graph',workId}, initiatorActorId, ownerActorId (normally the Human acceptor, not the Worker), candidateWorkerIds, humanActorIds, workspaceId, permissionCeiling, acceptanceCriteria, priority, and budget:{maxAttempts,maxRuntimeMs,maxCostUsd?}. update-task uses targetId plus payload {patch}.",
    "create-flow payload is a plan draft with name, description, trigger, actors, workspaces, steps, permissionCeiling, and budget. Actor and Workspace declarations use local IDs inside the draft plus existingActorId/workspaceId for known resources; Steps refer to those local IDs. Never emit Flow id, status, version, createdAt, or updatedAt: the Control Plane owns and materializes them. publish-flow must depend on create-flow and use payload {flowRef:<create operation ID>}.",
    "For legacy plan actors, use existingActorId exactly for known humans or Adopted Workers. For a new Native Worker, specify engine and a concrete harness prompt.",
    "A daily wall-clock schedule uses intervalMs=86400000 plus HH:mm timeOfDay and an IANA timezone. Ask one clarification for weekly or other wall-clock cadences until an explicit calendar cadence is available. When the user gives a local clock time without another timezone, use the provided Local IANA timezone without asking. Ask about timezone only when the user explicitly needs a different location, the location is materially ambiguous, or no valid local timezone is available.",
    `All step actorId/workspaceIds/dependsOn values refer to IDs declared inside the ProductionPlan. Use workspaceId=${input.workspaceId} for the configured local workspace.`,
    "Keep user-visible text concise and in the user's language. Put precise executable details in the structured fields.",
  ].join("\n");
}

function builtinSkill(): string {
  try { return readFileSync(resolve(process.cwd(), "skills/production-graph-brainstorm/SKILL.md"), "utf8"); }
  catch { return "Clarify durable actors, workspaces, triggers, dependencies, permissions, budgets, and acceptance criteria before proposing a ProductionPlan."; }
}

function parseResultObject(result: string | undefined): unknown {
  if (!result) throw new Error("Steward Claude Code returned no structured output");
  try { return JSON.parse(result) as unknown; } catch { throw new Error("Steward Claude Code result was not valid JSON"); }
}

function parseStreamEnvelope(stdout: string): ClaudeJsonResult {
  const events = stdout.split("\n").map(parseStreamLine).filter((event): event is ClaudeStreamEvent => Boolean(event));
  const result = [...events].reverse().find((event) => event.type === "result");
  if (!result) throw new Error("Steward Claude Code returned no result event");
  return result;
}

function parseStreamLine(line: string): ClaudeStreamEvent | undefined {
  if (!line.trim()) return undefined;
  try { return JSON.parse(line) as ClaudeStreamEvent; }
  catch { return undefined; }
}

function usesInspectionTool(event: ClaudeStreamEvent): boolean {
  return (event.message?.content ?? []).some((content) => content.type === "tool_use" && ["Read", "Glob", "Grep", "Bash"].includes(content.name ?? ""));
}

function inspectionTools(): string {
  return ["Read", "Glob", "Grep", "Bash(pwd)", "Bash(git status:*)", "Bash(git branch:*)", "Bash(git log:*)", "Bash(git rev-parse:*)", "Bash(git diff:*)", "Bash(git ls-files:*)"].join(",");
}
