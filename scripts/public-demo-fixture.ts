import { createHash } from "node:crypto";
import {
  ApplicationService,
  ControlPlane,
  emptyProjection,
  reduceProjection,
  type ClockPort,
  type ExecutorPort,
  type StewardPort,
} from "@mycel/application";
import type {
  AgentStepExecutionResult,
  AnyWorkerSpecVersion,
  CollaborationChange,
  ExecutionContract,
  FlowDefinition,
  FlowRun,
  HarnessIntent,
  StewardResult,
  WeaveOperation,
  WorkerProfile,
  WorkerSession,
} from "@mycel/domain";
import { LocalFlowEngine, type AgentStepInput, type FlowEnginePort } from "@mycel/flow-engine";
import { SqliteEventStore } from "@mycel/ledger-sqlite";

const OWNER_ID = "human:owner";
const RESEARCHER_ID = "worker:adopted:researcher";
const RELEASE_STEWARD_ID = "worker:native:release-steward";
const FLOW_ID = "flow:public-release-review";
const PUBLIC_REPOSITORY_ID = "repository:public-demo";
const PUBLIC_TEST_COMMAND_ID = "test:public-demo";
const EXECUTOR_ERROR = "public demo fixture must not invoke a Worker";
const PUBLIC_PRESENTATION_TIME = "2026-01-15T09:00:00.000Z";
const PUBLIC_REVIEW_BUDGET_MS = 24 * 60 * 60_000;
const PUBLIC_FIXTURE_INTENTS = [
  { messageId: "fixture:question", text: "What is waiting for review before this fictional release can be published?" },
  { messageId: "fixture:clarification", text: "Help me choose how the fictional release review should start." },
  { messageId: "fixture:changeset", text: "Prepare the fictional release review harness for Owner approval." },
] as const;

class MutableFixtureClock implements ClockPort {
  #time: number;

  constructor(now: string) {
    this.#time = parseFixtureTime(now);
  }

  set(now: string): void {
    this.#time = parseFixtureTime(now);
  }

  now(): Date {
    return new Date(this.#time);
  }
}

class PublicDemoApplication extends ApplicationService {
  presentationClock!: MutableFixtureClock;
}

class DeterministicSteward implements StewardPort {
  async respond(input: Parameters<StewardPort["respond"]>[0]): Promise<HarnessIntent | StewardResult> {
    if (input.sourceMessageId === PUBLIC_FIXTURE_INTENTS[0].messageId) {
      return {
        kind: "answer",
        text: "## Release review\n\nOne release review is waiting for **Owner approval** before publication.",
        reasoningSummary: "The public fixture exposes the current approval checkpoint.",
      };
    }
    if (input.sourceMessageId === PUBLIC_FIXTURE_INTENTS[1].messageId) {
      return {
        kind: "clarification",
        text: "Would the Owner like a manual or scheduled release review?",
        reasoningSummary: "The release trigger must be chosen before changing the Flow.",
      };
    }
    if (input.sourceMessageId === PUBLIC_FIXTURE_INTENTS[2].messageId) {
      return {
        kind: "changeset",
        text: "I prepared a versioned release review harness for Owner approval.",
        reasoningSummary: "Publishing a WorkerSpec is a durable, approval-gated change.",
        changeSet: {
          title: "Publish release review harness",
          intentSummary: "Publish the Release Steward harness",
          operations: [{
            id: "publish",
            kind: "publish-worker-spec",
            targetId: RELEASE_STEWARD_ID,
            dependsOn: [],
            payload: { lifecycle: "persistent" },
          }],
          preconditions: [],
        },
      };
    }
    throw new Error(`unsupported public fixture intent: ${input.text}`);
  }
}

class ThrowingExecutor implements ExecutorPort {
  async prepare(): Promise<ExecutionContract> {
    throw new Error(EXECUTOR_ERROR);
  }

  async execute(): Promise<never> {
    throw new Error(EXECUTOR_ERROR);
  }

  async cancel(): Promise<boolean> {
    throw new Error(EXECUTOR_ERROR);
  }
}

export class PresentationFlowPort implements FlowEnginePort {
  constructor(private readonly application: ApplicationService) {}

  async persistDefinition(flow: FlowDefinition): Promise<void> {
    this.application.recordFlowDefinition(flow);
  }

  async persistRun(run: FlowRun, message: string): Promise<void> {
    this.application.recordFlowRun(run, message);
  }

  async persistCollaboration(change: CollaborationChange, message: string, idempotencyKey: string): Promise<void> {
    this.application.recordCollaboration(change, message, idempotencyKey);
  }

  actorCapabilities(): string[] {
    return ["repository-read"];
  }

  actorCapacity(): number {
    return 2;
  }

  async executeAgentStep(input: AgentStepInput): Promise<AgentStepExecutionResult> {
    return {
      status: "completed",
      summary: `${input.step.name} completed with review-ready evidence.`,
      output: { outcome: "review-ready" },
    };
  }
}

export async function createPublicDemoApplication(dataFile: string): Promise<ApplicationService> {
  const clock = new MutableFixtureClock(PUBLIC_PRESENTATION_TIME);
  const store = new SqliteEventStore(dataFile, emptyProjection(), reduceProjection);
  const application = new PublicDemoApplication(
    store,
    new DeterministicSteward(),
    new ThrowingExecutor(),
    {
      repositoryId: PUBLIC_REPOSITORY_ID,
      executorActorId: RESEARCHER_ID,
      ownerActorId: OWNER_ID,
      stewardActorId: RELEASE_STEWARD_ID,
      testCommandId: PUBLIC_TEST_COMMAND_ID,
      testCommandArgv: [],
      initialGraphOperations: publicInitialGraphOperations(PUBLIC_PRESENTATION_TIME),
    },
    undefined,
    clock,
  );
  application.presentationClock = clock;
  await application.initialize();
  application.setStewardControlPlane(new ControlPlane(store, {
    executeCommand: async () => {
      throw new Error("public demo fixture does not execute commands");
    },
    applyChange: async () => {
      throw new Error("public demo fixture does not apply ChangeSets");
    },
  }, clock));
  return application;
}

export async function seedPublicDemo(application: ApplicationService, now = PUBLIC_PRESENTATION_TIME): Promise<void> {
  if (!(application instanceof PublicDemoApplication)) throw new Error("public demo application clock is unavailable");
  const clock = application.presentationClock;
  clock.set(now);
  await seedPublicDemoAt(application, now, clock);
}

async function seedPublicDemoAt(application: ApplicationService, now: string, clock: ClockPort): Promise<void> {
  application.applyControlGraphOperations(presentationTimestampOperations(now), "public-fixture:timestamps", OWNER_ID);

  const researcherSpec: AnyWorkerSpecVersion = {
    schemaVersion: 1,
    id: "worker-spec:worker:adopted:researcher:v1",
    workerId: RESEARCHER_ID,
    version: 1,
    engine: "codex",
    systemPrompt: "Inspect repository evidence and return a concise release summary.",
    legacySkillRefs: [],
    legacyToolRefs: ["Read", "Glob", "Grep"],
    fileRefs: [],
    lifecycle: "persistent",
    legacyMemoryPolicy: "flow",
    sessionPolicy: { maxTurns: 12 },
    budget: { maxCostUsd: 0 },
    orchestration: { enabled: false, maxDelegationDepth: 0, maxFanOut: 0 },
    createdAt: now,
  };
  const releaseStewardSpec: AnyWorkerSpecVersion = {
    schemaVersion: 1,
    id: "worker-spec:worker:native:release-steward:v1",
    workerId: RELEASE_STEWARD_ID,
    version: 1,
    engine: "claude-code",
    systemPrompt: "Summarize evidence and request Owner approval before release publication.",
    legacySkillRefs: [],
    legacyToolRefs: ["Read", "Glob", "Grep"],
    fileRefs: [],
    lifecycle: "persistent",
    legacyMemoryPolicy: "flow",
    sessionPolicy: { maxTurns: 16 },
    budget: { maxCostUsd: 0 },
    orchestration: { enabled: false, maxDelegationDepth: 0, maxFanOut: 0 },
    createdAt: now,
  };
  application.recordWorkerProfile(workerProfile({
    id: RESEARCHER_ID,
    name: "Local Research Worker",
    source: "adopted",
    adapterKind: "codex",
    specId: researcherSpec.id,
    now,
  }), researcherSpec);
  application.recordWorkerProfile(workerProfile({
    id: RELEASE_STEWARD_ID,
    name: "Release Steward",
    source: "native",
    adapterKind: "claude-code",
    specId: releaseStewardSpec.id,
    now,
  }), releaseStewardSpec);

  const completedSession: WorkerSession = {
    schemaVersion: 2,
    id: "worker-session:public-research-completed",
    workerId: RESEARCHER_ID,
    adapterKind: "codex",
    workerSpecVersionId: researcherSpec.id,
    workspaceId: PUBLIC_REPOSITORY_ID,
    phase: "completed",
    mode: "explore",
    instruction: "Review the fictional public release evidence using repository-read access.",
    summary: "The fictional repository review completed successfully. The Worker compared the release checklist, test evidence, documentation status, and Owner approval boundary, then prepared a concise publication-readiness summary. All observations refer only to deterministic public demo data. No external service was contacted, no workspace change was attempted, and the evidence remains available for the Owner to inspect before making a release decision.",
    lastEvent: "Completed the fictional release-readiness review with safe evidence metadata.",
    createdAt: now,
    updatedAt: now,
  };
  const failedSession: WorkerSession = {
    schemaVersion: 2,
    id: "worker-session:public-release-failed",
    workerId: RELEASE_STEWARD_ID,
    adapterKind: "claude-code",
    workerSpecVersionId: releaseStewardSpec.id,
    workspaceId: PUBLIC_REPOSITORY_ID,
    phase: "failed",
    mode: "explore",
    instruction: "Prepare a fictional publication-readiness review from the available safe evidence.",
    summary: "The fictional review paused before publication readiness was recorded. Ask Steward to start a new review against the current Graph and available evidence.",
    lastEvent: "Review stopped safely; current Graph and evidence were not changed.",
    createdAt: now,
    updatedAt: now,
  };
  application.recordWorkerSession(completedSession);
  application.recordWorkerSession(failedSession);

  for (const intent of PUBLIC_FIXTURE_INTENTS) {
    await application.submitIntent({
      messageId: intent.messageId,
      channel: "web",
      conversationId: "public:demo",
      actorId: OWNER_ID,
      text: intent.text,
    });
  }

  const engine = new LocalFlowEngine(new PresentationFlowPort(application), clock);
  await engine.save({
    id: FLOW_ID,
    name: "Public release review",
    description: "Parallel evidence review with an explicit Owner approval checkpoint.",
    workspaceId: "repository",
    status: "draft",
    version: 0,
    trigger: { kind: "manual" },
    steps: [
      flowStep("inspect", "Inspect release evidence", RESEARCHER_ID, []),
      flowStep("summarize", "Summarize release evidence", RELEASE_STEWARD_ID, []),
      flowStep("approve", "Owner approval", OWNER_ID, ["inspect", "summarize"], "human"),
      flowStep("publish", "Record publication readiness", RELEASE_STEWARD_ID, ["approve"]),
    ],
    permissionCeiling: ["repository-read"],
    maxConcurrency: 4,
    budget: { maxRuntimeMs: PUBLIC_REVIEW_BUDGET_MS, maxTotalAttempts: 8, maxCostUsd: 0 },
    createdAt: now,
  });
  await engine.publish(FLOW_ID);

  const completedRun = await engine.trigger(FLOW_ID, "manual");
  await engine.waitForIdle();
  const approval = engine.details(completedRun.id).humanTasks.find((task) => task.phase === "open");
  if (!approval) throw new Error("public demo approval task was not created");
  await engine.claimHumanTask(approval.id, OWNER_ID, "public-fixture:first-run:claim");
  await engine.completeHumanTask(
    approval.id,
    OWNER_ID,
    { summary: "Owner approved the fictional release evidence.", output: { decision: "approved" } },
    "public-fixture:first-run:complete",
  );
  await engine.waitForIdle();

  await engine.trigger(FLOW_ID, "manual");
  await engine.waitForIdle();
  engine.stop();

  const evidenceHash = createHash("sha256").update("public demo release evidence").digest("hex");
  application.applyControlGraphOperations([
    {
      operationId: "fixture-add-release-evidence",
      op: "add_node",
      explanation: "Add fictional release evidence",
      node: {
        id: "artifact:public-release-evidence",
        name: "Release evidence summary",
        type: "artifact",
        kind: "evidence",
        uri: "mycel://public-demo/evidence/release-summary",
        sha256: evidenceHash,
        mediaType: "text/markdown",
        summary: "Sanitized evidence prepared for Owner review.",
        createdAt: now,
        updatedAt: now,
      },
    },
    {
      operationId: "fixture-flow-produces-evidence",
      op: "add_edge",
      explanation: "Connect the release Flow to its evidence",
      edge: { id: "edge:public-flow-evidence", type: "produces", from: `work:flow:${FLOW_ID}`, to: "artifact:public-release-evidence" },
    },
  ], "public-fixture:presentation-graph", RELEASE_STEWARD_ID);
}

function publicInitialGraphOperations(now: string): WeaveOperation[] {
  return [
    {
      operationId: "public-bootstrap-owner",
      op: "add_node",
      explanation: "Register the fictional public demo Owner",
      node: { id: OWNER_ID, name: "Demo Owner", type: "actor", kind: "human", source: "human", status: "online", createdAt: now, updatedAt: now },
    },
    {
      operationId: "public-bootstrap-researcher",
      op: "add_node",
      explanation: "Register the fictional adopted research Worker",
      node: { id: RESEARCHER_ID, name: "Local Research Worker", type: "actor", kind: "agent", source: "adopted", adapterKind: "codex", runtime: "codex", lifecycle: "persistent", status: "online", createdAt: now, updatedAt: now },
    },
    {
      operationId: "public-bootstrap-release-steward",
      op: "add_node",
      explanation: "Register the fictional native release Worker",
      node: { id: RELEASE_STEWARD_ID, name: "Release Steward", type: "actor", kind: "agent", source: "graph-native", adapterKind: "claude-code", runtime: "claude-code", lifecycle: "persistent", status: "online", createdAt: now, updatedAt: now },
    },
    {
      operationId: "public-bootstrap-repository-read",
      op: "add_node",
      explanation: "Declare the public demo permission ceiling",
      node: { id: "cap:repo-read", name: "Repository read", type: "capability", kind: "repository-read", scope: PUBLIC_REPOSITORY_ID, constraints: {}, createdAt: now, updatedAt: now },
    },
    {
      operationId: "public-bootstrap-authorize-researcher",
      op: "add_edge",
      explanation: "Authorize the research Worker to inspect repository evidence",
      edge: { id: "edge:public-researcher-read", type: "authorization", from: RESEARCHER_ID, to: "cap:repo-read", permission: "read", scope: PUBLIC_REPOSITORY_ID, source: "public-fixture" },
    },
    {
      operationId: "public-bootstrap-authorize-release-steward",
      op: "add_edge",
      explanation: "Authorize the release Worker to inspect repository evidence",
      edge: { id: "edge:public-release-steward-read", type: "authorization", from: RELEASE_STEWARD_ID, to: "cap:repo-read", permission: "read", scope: PUBLIC_REPOSITORY_ID, source: "public-fixture" },
    },
  ];
}

function presentationTimestampOperations(now: string): WeaveOperation[] {
  return [
    { operationId: "fixture-timestamp-owner", op: "update_node", explanation: "Fix the public Owner timestamp", nodeId: OWNER_ID, patch: { createdAt: now, updatedAt: now } },
    { operationId: "fixture-timestamp-researcher", op: "update_node", explanation: "Fix the public research Worker timestamp", nodeId: RESEARCHER_ID, patch: { createdAt: now, updatedAt: now } },
    { operationId: "fixture-timestamp-release-steward", op: "update_node", explanation: "Fix the public release Worker timestamp", nodeId: RELEASE_STEWARD_ID, patch: { createdAt: now, updatedAt: now } },
    { operationId: "fixture-timestamp-permission", op: "update_node", explanation: "Fix the public permission timestamp", nodeId: "cap:repo-read", patch: { createdAt: now, updatedAt: now } },
  ];
}

function parseFixtureTime(now: string): number {
  const time = Date.parse(now);
  if (!Number.isFinite(time)) throw new Error(`invalid public fixture timestamp: ${now}`);
  return time;
}

function workerProfile(input: {
  id: string;
  name: string;
  source: WorkerProfile["source"];
  adapterKind: WorkerProfile["adapterKind"];
  specId: string;
  now: string;
}): WorkerProfile {
  return {
    schemaVersion: 2,
    id: input.id,
    name: input.name,
    source: input.source,
    adapterKind: input.adapterKind,
    status: "online",
    capabilities: ["repository-read"],
    contractLevel: "evidence",
    lifecycle: "persistent",
    defaultSpecVersionId: input.specId,
    maxConcurrentSessions: 2,
    controlCapabilities: { send: false, interrupt: false, resume: false, cancel: false, fork: false, structuredOutput: true },
    registeredAt: input.now,
    updatedAt: input.now,
  };
}

function flowStep(
  id: string,
  name: string,
  actorId: string,
  dependsOn: string[],
  kind: "agent" | "human" = "agent",
): FlowDefinition["steps"][number] {
  return {
    id,
    name,
    kind,
    actorId,
    prompt: kind === "human" ? "Review the evidence summaries and approve or hold the release." : `${name} using repository-read access only.`,
    dependsOn,
    condition: dependsOn.length > 0 ? "previous-succeeded" : "always",
    timeoutMs: 30_000,
    maxAttempts: 1,
    join: { mode: "all" },
    requiredCapabilities: ["repository-read"],
  };
}
