import { z } from "zod";
import type { AgentProfile, AgentSession, AgentSpec } from "./control-plane.js";

export const WorkerAdapterKindSchema = z.enum(["claude-code", "codex", "mcp", "a2a"]);
export const WorkerSourceSchema = z.enum(["adopted", "native"]);
export const WorkerLifecycleSchema = z.enum(["run-scoped", "flow-scoped", "persistent", "archived"]);
export const WorkerRuntimeStatusSchema = z.enum(["online", "offline", "busy", "degraded"]);

export const WorkerControlCapabilitiesSchema = z.object({
  send: z.boolean(),
  interrupt: z.boolean(),
  resume: z.boolean(),
  cancel: z.boolean(),
  fork: z.boolean(),
  structuredOutput: z.boolean(),
});

export const WorkerProfileSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  name: z.string().min(1),
  source: WorkerSourceSchema,
  adapterKind: WorkerAdapterKindSchema,
  status: WorkerRuntimeStatusSchema,
  version: z.string().optional(),
  capabilities: z.array(z.string()),
  contractLevel: z.enum(["status", "results", "evidence", "control"]),
  connectionUri: z.string().optional(),
  lifecycle: WorkerLifecycleSchema,
  defaultSpecVersionId: z.string().optional(),
  parentWorkerId: z.string().optional(),
  subgraphId: z.string().optional(),
  maxConcurrentSessions: z.number().int().positive().optional(),
  controlCapabilities: WorkerControlCapabilitiesSchema,
  registeredAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const SecretRefSchema = z.object({ secretRef: z.string().min(1) }).strict();
const PlainConfigValueSchema = z.object({ value: z.string() }).strict();
export const HarnessConfigValueSchema = z.union([SecretRefSchema, PlainConfigValueSchema]);

const sensitiveConfigKey = /token|secret|password|credential|private[_.-]?key/i;
const shellSyntax = /[\s;&|`$<>\n\r]/;

export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(["stdio", "http"]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).default([]),
  url: z.string().url().optional(),
  env: z.record(z.string(), HarnessConfigValueSchema).default({}),
  allowedTools: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
}).superRefine((server, context) => {
  if (server.transport === "stdio") {
    if (!server.command) {
      context.addIssue({ code: "custom", path: ["command"], message: "stdio MCP servers require an executable command" });
    } else if (shellSyntax.test(server.command)) {
      context.addIssue({ code: "custom", path: ["command"], message: "MCP command must be one executable without shell syntax; pass arguments separately" });
    }
    if (server.url) context.addIssue({ code: "custom", path: ["url"], message: "stdio MCP servers cannot define a URL" });
  } else {
    if (!server.url) context.addIssue({ code: "custom", path: ["url"], message: "http MCP servers require a URL" });
    if (server.command) context.addIssue({ code: "custom", path: ["command"], message: "http MCP servers cannot define a command" });
  }

  for (const [key, value] of Object.entries(server.env)) {
    if (sensitiveConfigKey.test(key) && !("secretRef" in value)) {
      context.addIssue({ code: "custom", path: ["env", key], message: `Sensitive value ${key} must use SecretRef` });
    }
  }
});

export const WorkerSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string(),
  enabled: z.boolean(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const WorkerToolSchema = z.object({
  name: z.string().min(1),
  source: z.enum(["builtin", "mcp", "cli"]),
  permission: z.enum(["read", "write", "execute", "network"]),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const WorkerSpecVersionSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  workerId: z.string().min(1),
  version: z.number().int().positive(),
  engine: z.object({
    adapter: z.enum(["claude-code", "codex"]),
    model: z.string().optional(),
    effort: z.string().optional(),
  }),
  systemPrompt: z.string(),
  skills: z.array(WorkerSkillSchema),
  mcpServers: z.array(McpServerConfigSchema),
  tools: z.array(WorkerToolSchema),
  fileRefs: z.array(z.string()),
  knowledgeRefs: z.array(z.string()),
  memory: z.object({
    scope: z.enum(["session", "task", "flow"]),
    resume: z.boolean(),
    summaryPolicy: z.enum(["none", "final", "rolling"]),
  }),
  sessionPolicy: z.object({
    maxTurns: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    maxConcurrentSessions: z.number().int().positive(),
  }),
  budget: z.object({
    maxCostUsd: z.number().nonnegative().optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
  orchestration: z.object({
    enabled: z.boolean(),
    maxDelegationDepth: z.number().int().nonnegative(),
    maxFanOut: z.number().int().nonnegative(),
    allowedWorkerKinds: z.array(WorkerAdapterKindSchema),
  }),
  lifecycle: WorkerLifecycleSchema,
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
});

export const LegacyWorkerSpecVersionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  workerId: z.string(),
  version: z.number().int().positive(),
  engine: z.enum(["claude-code", "codex"]),
  systemPrompt: z.string(),
  legacySkillRefs: z.array(z.string()),
  legacyToolRefs: z.array(z.string()),
  fileRefs: z.array(z.string()),
  lifecycle: WorkerLifecycleSchema,
  legacyMemoryPolicy: z.enum(["session", "run", "flow"]),
  sessionPolicy: z.object({ maxTurns: z.number().int().positive() }),
  budget: z.object({ maxCostUsd: z.number().nonnegative() }),
  orchestration: z.object({
    enabled: z.boolean(),
    maxDelegationDepth: z.number().int().nonnegative(),
    maxFanOut: z.number().int().nonnegative(),
  }),
  createdAt: z.string().datetime(),
});

export const WorkerSessionSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  workerId: z.string().min(1),
  adapterKind: WorkerAdapterKindSchema,
  taskId: z.string().optional(),
  attemptId: z.string().optional(),
  workId: z.string().optional(),
  flowRunId: z.string().optional(),
  workerSpecVersionId: z.string().optional(),
  providerSessionId: z.string().optional(),
  permissionLeaseId: z.string().optional(),
  workspaceId: z.string().optional(),
  phase: z.enum(["starting", "running", "blocked", "completed", "failed", "interrupted", "canceled"]),
  mode: z.enum(["explore", "execute"]),
  instruction: z.string(),
  summary: z.string(),
  lastEvent: z.string(),
  retryOf: z.string().optional(),
  forkedFrom: z.string().optional(),
  replacedBy: z.string().optional(),
  rawContentExpiresAt: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type WorkerAdapterKind = z.infer<typeof WorkerAdapterKindSchema>;
export type WorkerSource = z.infer<typeof WorkerSourceSchema>;
export type WorkerLifecycle = z.infer<typeof WorkerLifecycleSchema>;
export type WorkerControlCapabilities = z.infer<typeof WorkerControlCapabilitiesSchema>;
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;
export type WorkerSpecVersion = z.infer<typeof WorkerSpecVersionSchema>;
export type LegacyWorkerSpecVersion = z.infer<typeof LegacyWorkerSpecVersionSchema>;
export type AnyWorkerSpecVersion = WorkerSpecVersion | LegacyWorkerSpecVersion;
export type WorkerSession = z.infer<typeof WorkerSessionSchema>;

function hasCapability(profile: AgentProfile, capability: string): boolean {
  return profile.capabilities.some((candidate) => candidate.toLowerCase() === capability.toLowerCase());
}

export function legacyAgentProfileToWorker(profile: AgentProfile): WorkerProfile {
  const controllableCli = profile.adapterKind === "claude-code" || profile.adapterKind === "codex";
  return {
    schemaVersion: 2,
    id: profile.id,
    name: profile.name,
    source: profile.source === "graph-native" ? "native" : "adopted",
    adapterKind: profile.adapterKind,
    status: profile.status,
    ...(profile.version ? { version: profile.version } : {}),
    capabilities: profile.capabilities,
    contractLevel: profile.contractLevel,
    ...(profile.connectionUri ? { connectionUri: profile.connectionUri } : {}),
    lifecycle: profile.lifecycle,
    ...(profile.specVersionId ? { defaultSpecVersionId: profile.specVersionId } : {}),
    ...(profile.parentAgentId ? { parentWorkerId: profile.parentAgentId } : {}),
    ...(profile.subgraphId ? { subgraphId: profile.subgraphId } : {}),
    ...(profile.maxConcurrentSessions ? { maxConcurrentSessions: profile.maxConcurrentSessions } : {}),
    controlCapabilities: {
      send: controllableCli || hasCapability(profile, "send"),
      interrupt: controllableCli || hasCapability(profile, "interrupt"),
      resume: hasCapability(profile, "session-resume") || hasCapability(profile, "resume"),
      cancel: controllableCli || hasCapability(profile, "cancel"),
      fork: hasCapability(profile, "fork"),
      structuredOutput: hasCapability(profile, "structured-output"),
    },
    registeredAt: profile.registeredAt,
    updatedAt: profile.updatedAt,
  };
}

export function legacyAgentSpecToWorker(spec: AgentSpec): LegacyWorkerSpecVersion {
  return {
    schemaVersion: 1,
    id: spec.id,
    workerId: spec.agentId,
    version: spec.version,
    engine: spec.engine,
    systemPrompt: spec.prompt,
    legacySkillRefs: spec.skills,
    legacyToolRefs: spec.tools,
    fileRefs: spec.fileRefs,
    lifecycle: spec.lifecycle,
    legacyMemoryPolicy: spec.memoryPolicy,
    sessionPolicy: { maxTurns: spec.maxTurns },
    budget: { maxCostUsd: spec.maxBudgetUsd },
    orchestration: {
      enabled: spec.canOrchestrate,
      maxDelegationDepth: spec.maxDelegationDepth,
      maxFanOut: spec.maxFanOut,
    },
    createdAt: spec.createdAt,
  };
}

export function legacyAgentSessionToWorker(session: AgentSession): WorkerSession {
  return {
    schemaVersion: 2,
    id: session.id,
    workerId: session.agentId,
    adapterKind: session.adapterKind,
    ...(session.workId ? { workId: session.workId } : {}),
    ...(session.flowRunId ? { flowRunId: session.flowRunId } : {}),
    ...(session.specVersionId ? { workerSpecVersionId: session.specVersionId } : {}),
    ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
    phase: session.phase,
    mode: session.mode,
    instruction: session.prompt,
    summary: session.summary,
    lastEvent: session.lastEvent,
    ...(session.rawContentExpiresAt ? { rawContentExpiresAt: session.rawContentExpiresAt } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
