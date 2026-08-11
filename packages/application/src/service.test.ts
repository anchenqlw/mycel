import type { ChangeSet, ControlCommand, ExecutionContract, FlowDefinition, HarnessIntent, StewardResult, WeaveDiff } from "@mycel/domain";
import { SqliteEventStore } from "@mycel/ledger-sqlite";
import { describe, expect, it } from "vitest";
import type { ExecutorPort, StewardPort } from "./ports.js";
import { emptyProjection, reduceProjection } from "./projection.js";
import { ApplicationService } from "./service.js";
import { ControlPlane } from "./control-plane.js";

const sha = "a".repeat(64);

class FakeSteward implements StewardPort {
  async respond(input: Parameters<StewardPort["respond"]>[0]): Promise<StewardResult | HarnessIntent> {
    const now = new Date().toISOString();
    const diff: WeaveDiff = {
      id: "ignored",
      baseGraphVersion: input.graph.version,
      originatorActorId: input.originatorActorId,
      sourceMessageId: input.sourceMessageId,
      intentSummary: input.text,
      workTitle: "Fix CSV export",
      acceptanceCriteria: ["npm test passes"],
      stewardExplanation: "Create a work, assign Claude, retain human accountability, and request run-scoped write access.",
      executionDraft: {
        executorActorId: input.executorActorId,
        repositoryId: input.repositoryId,
        testCommandId: input.testCommandId,
        requiredEvidence: ["patch", "test-report", "execution-summary"],
      },
      operations: [
        {
          operationId: "add-work",
          op: "add_node",
          explanation: "Create Work",
          node: {
            id: "work:csv",
            name: "Fix CSV export",
            type: "work",
            kind: "run",
            description: input.text,
            status: "proposed",
            acceptanceCriteria: ["npm test passes"],
            risk: "red",
            createdAt: now,
            updatedAt: now,
          },
        },
        { operationId: "assign-executor", op: "add_edge", explanation: "Assign Claude", edge: { id: "edge:executor", type: "assignment", from: input.executorActorId, to: "work:csv", role: "executor" } },
        { operationId: "assign-owner", op: "add_edge", explanation: "Keep owner human", edge: { id: "edge:owner", type: "assignment", from: input.originatorActorId, to: "work:csv", role: "owner" } },
        { operationId: "assign-acceptor", op: "add_edge", explanation: "Keep acceptor human", edge: { id: "edge:acceptor", type: "assignment", from: input.originatorActorId, to: "work:csv", role: "acceptor" } },
        { operationId: "grant-write", op: "add_edge", explanation: "Grant run-scoped write", edge: { id: "edge:write", type: "authorization", from: input.executorActorId, to: "cap:repo-write", scope: "work:csv" } },
      ],
    };
    return { kind: "weave_diff", diff };
  }
}

class StaticSteward implements StewardPort {
  calls = 0;
  lastInput: Parameters<StewardPort["respond"]>[0] | undefined;

  constructor(private readonly result: StewardResult | HarnessIntent) {}

  async respond(input: Parameters<StewardPort["respond"]>[0]): Promise<StewardResult | HarnessIntent> {
    this.calls += 1;
    this.lastInput = input;
    return this.result;
  }
}

class FakeExecutor implements ExecutorPort {
  executions = 0;

  async prepare(input: Parameters<ExecutorPort["prepare"]>[0]): Promise<ExecutionContract> {
    return {
      runId: input.runId,
      workId: input.work.id,
      executorActorId: input.executorActorId,
      ownerActorId: input.ownerActorId,
      acceptorActorId: input.acceptorActorId,
      repositoryId: input.repositoryId,
      baselineCommit: "1234567",
      worktreePath: "/tmp/worktree",
      task: input.work.description,
      acceptanceCriteria: input.work.acceptanceCriteria,
      allowedTools: ["Read", "Glob", "Grep", "Edit", "Write"],
      testCommandArgv: input.testCommandArgv,
      timeoutMs: 1_000,
      maxTurns: 3,
      maxBudgetUsd: 1,
      requiredEvidence: ["patch", "test-report", "execution-summary"],
    };
  }

  async execute(contract: ExecutionContract, onProgress: Parameters<ExecutorPort["execute"]>[1]) {
    this.executions += 1;
    await onProgress({ stage: "editing", message: "Edited src/export.js" });
    return {
      success: true,
      exitCode: 0,
      summary: "Fixed CSV export",
      durationMs: 10,
      evidence: [
        { artifactId: "artifact:patch", runId: contract.runId, workId: contract.workId, kind: "patch" as const, uri: "/tmp/change.patch", sha256: sha, mediaType: "text/x-diff", summary: "One line" },
        { artifactId: "artifact:test", runId: contract.runId, workId: contract.workId, kind: "test-report" as const, uri: "/tmp/test.log", sha256: sha, mediaType: "text/plain", summary: "Tests pass", passed: true },
        { artifactId: "artifact:summary", runId: contract.runId, workId: contract.workId, kind: "execution-summary" as const, uri: "/tmp/summary.json", sha256: sha, mediaType: "application/json", summary: "Done" },
      ],
    };
  }

  async cancel(): Promise<boolean> {
    return true;
  }
}

class CancellableExecutor implements ExecutorPort {
  executions = 0;
  release: (() => void) | undefined;

  async prepare(input: Parameters<ExecutorPort["prepare"]>[0]): Promise<ExecutionContract> {
    return new FakeExecutor().prepare(input);
  }

  async execute(_contract: ExecutionContract, _onProgress: Parameters<ExecutorPort["execute"]>[1]) {
    this.executions += 1;
    await new Promise<void>((resolve) => { this.release = resolve; });
    return {
      success: false,
      exitCode: null,
      summary: "interrupted",
      durationMs: 10,
      evidence: [],
      error: "interrupted",
    };
  }

  async cancel(): Promise<boolean> {
    return true;
  }
}

describe("ApplicationService", () => {
  it("records a Flow definition and its derived Graph facts in one event", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const service = new ApplicationService(store, new FakeSteward(), new FakeExecutor(), {
      repositoryId: "repo:demo",
      executorActorId: "agent:claude",
      ownerActorId: "human:owner",
      stewardActorId: "agent:steward",
      testCommandId: "test:npm",
      testCommandArgv: ["npm", "test"],
    });
    await service.initialize();
    const before = store.readAll().length;
    const flow: FlowDefinition = {
      id: "flow:atomic",
      name: "Atomic Flow",
      description: "One fact boundary",
      status: "draft",
      version: 0,
      trigger: { kind: "manual" },
      steps: [],
      permissionCeiling: [],
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };

    service.recordFlowDefinition(flow);

    expect(store.readAll()).toHaveLength(before + 1);
    expect(service.getProjection().flows[flow.id]).toEqual(flow);
    expect(service.getProjection().graph.nodes).toContainEqual(expect.objectContaining({ id: "work:flow:flow:atomic" }));
    store.close();
  });

  it("leaves both Flow and Graph unchanged when the atomic projection is rejected", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const service = new ApplicationService(store, new FakeSteward(), new FakeExecutor(), {
      repositoryId: "repo:demo", executorActorId: "agent:claude", ownerActorId: "human:owner", stewardActorId: "agent:steward", testCommandId: "test:npm", testCommandArgv: ["npm", "test"],
    });
    await service.initialize();
    const beforeEvents = store.readAll().length;
    const beforeGraph = structuredClone(service.getProjection().graph);
    const invalid: FlowDefinition = {
      id: "flow:invalid-atomic", name: "Invalid atomic Flow", description: "Must roll back", status: "published", version: 1,
      trigger: { kind: "manual" }, permissionCeiling: [], createdAt: "2026-08-10T12:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z",
      steps: [{ id: "review", name: "Review", kind: "human", actorId: "human:owner", prompt: "Review", dependsOn: ["missing"], condition: "previous-succeeded", timeoutMs: 60_000, maxAttempts: 1 }],
    };

    expect(() => service.recordFlowDefinition(invalid)).toThrow();
    expect(store.readAll()).toHaveLength(beforeEvents);
    expect(service.getProjection().flows[invalid.id]).toBeUndefined();
    expect(service.getProjection().graph).toEqual(beforeGraph);
    store.close();
  });

  it("runs the red approval, execution evidence, and human acceptance loop exactly once", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const executor = new FakeExecutor();
    const service = new ApplicationService(store, new FakeSteward(), executor, {
      repositoryId: "repo:demo",
      executorActorId: "agent:claude",
      ownerActorId: "human:owner",
      stewardActorId: "agent:steward",
      testCommandId: "test:npm",
      testCommandArgv: ["npm", "test"],
    });
    await service.initialize();

    const submitted = await service.submitIntent({
      messageId: "message-1",
      channel: "dingtalk",
      conversationId: "conversation-1",
      actorId: "human:owner",
      text: "Fix CSV export",
    });
    if (submitted.kind !== "weave_diff") throw new Error("expected a weave diff");
    const mutation = submitted.mutation;
    expect(mutation.status).toBe("partially_applied");
    expect(mutation.pendingOperationIds).toHaveLength(3);

    await service.approveMutation(mutation.id, "human:owner", "callback:approve-1");
    await service.approveMutation(mutation.id, "human:owner", "callback:approve-1");
    await service.waitForIdle();

    const beforeAcceptance = service.getProjection();
    const work = beforeAcceptance.graph.nodes.find((node) => node.id === "work:csv");
    expect(work?.type === "work" ? work.status : undefined).toBe("awaiting_acceptance");
    expect(Object.values(beforeAcceptance.evidence)).toHaveLength(3);
    expect(executor.executions).toBe(1);

    await service.acceptWork("work:csv", "human:owner", "callback:accept-1");
    const accepted = service.getProjection().graph.nodes.find((node) => node.id === "work:csv");
    expect(accepted?.type === "work" ? accepted.status : undefined).toBe("completed");
    expect(service.readLedger().some((event) => event.eventType === "Judgment")).toBe(true);
    store.close();
  });

  it("keeps canceled as the terminal run state when the executor returns late", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const executor = new CancellableExecutor();
    const service = new ApplicationService(store, new FakeSteward(), executor, {
      repositoryId: "repo:demo",
      executorActorId: "agent:claude",
      ownerActorId: "human:owner",
      stewardActorId: "agent:steward",
      testCommandId: "test:npm",
      testCommandArgv: ["npm", "test"],
    });
    await service.initialize();
    const submitted = await service.submitIntent({
      messageId: "message-cancel",
      channel: "web",
      conversationId: "web:owner",
      actorId: "human:owner",
      text: "Cancel this run",
    });
    if (submitted.kind !== "weave_diff") throw new Error("expected a weave diff");
    const mutation = submitted.mutation;
    await service.approveMutation(mutation.id, "human:owner", "approve-cancel-run");
    const run = Object.values(service.getProjection().runs)[0];
    if (!run) throw new Error("run was not dispatched");
    await service.cancelRun(run.id, "human:owner", "cancel-run");
    executor.release?.();
    await service.waitForIdle();
    expect(service.getProjection().runs[run.id]?.phase).toBe("canceled");
    expect(Object.values(service.getProjection().evidence)).toHaveLength(0);
    store.close();
  });

  it("answers a repository question without creating a graph mutation and replays idempotently", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const steward = new StaticSteward({
      kind: "answer",
      text: "当前工作仓库是 repo:demo。",
      reasoningSummary: "这是只读仓库信息查询。",
    });
    const service = new ApplicationService(store, steward, new FakeExecutor(), {
      repositoryId: "repo:demo",
      executorActorId: "agent:claude",
      ownerActorId: "human:owner",
      stewardActorId: "agent:steward",
      testCommandId: "test:npm",
      testCommandArgv: ["npm", "test"],
    });
    await service.initialize();
    const graphVersion = service.getProjection().graph.version;
    const phases: string[] = [];
    const input = {
      messageId: "message-question",
      channel: "web" as const,
      conversationId: "web:owner",
      actorId: "human:owner",
      text: "你现在在哪个仓库工作？",
      workspaceId: "workspace:custom",
      workspaceName: "Custom Workspace",
      workspacePath: "/tmp/custom-workspace",
      timezone: "Asia/Shanghai",
      onProgress: (phase: string) => { phases.push(phase); },
    };

    const first = await service.submitIntent(input);
    expect(first.kind).toBe("answer");
    expect(first.replayed).toBe(false);
    expect(service.getProjection().graph.version).toBe(graphVersion);
    expect(Object.values(service.getProjection().mutations)).toHaveLength(0);
    expect(Object.values(service.getProjection().runs)).toHaveLength(0);
    expect(steward.lastInput).toMatchObject({ workspaceId: "workspace:custom", workspaceName: "Custom Workspace", workspacePath: "/tmp/custom-workspace", localTimezone: "Asia/Shanghai" });
    expect(phases).toEqual(["preparing-workspace", "invoking-steward", "validating-result", "composing-response"]);

    const replay = await service.submitIntent(input);
    expect(replay.kind).toBe("answer");
    expect(replay.replayed).toBe(true);
    expect(steward.calls).toBe(1);
    expect(service.getProjection().stewardResponses).toHaveLength(1);
    store.close();
  });

  it("records a clarification without producing a diff", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const service = new ApplicationService(
      store,
      new StaticSteward({
        kind: "clarification",
        text: "你希望修改哪个页面？",
        reasoningSummary: "缺少执行变更所需的目标页面。",
      }),
      new FakeExecutor(),
      {
        repositoryId: "repo:demo",
        executorActorId: "agent:claude",
        ownerActorId: "human:owner",
        stewardActorId: "agent:steward",
        testCommandId: "test:npm",
        testCommandArgv: ["npm", "test"],
      },
    );
    await service.initialize();

    const result = await service.submitIntent({
      messageId: "message-clarification",
      channel: "dingtalk",
      conversationId: "conversation-1",
      actorId: "human:owner",
      text: "帮我改一下",
    });

    expect(result.kind).toBe("clarification");
    expect(Object.values(service.getProjection().mutations)).toHaveLength(0);
    expect(service.getProjection().stewardResponses[0]?.text).toBe("你希望修改哪个页面？");
    store.close();
  });

  it("materializes an approved Graph-native Actor as an AgentSpec without dispatching repository execution", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const executor = new FakeExecutor();
    const now = new Date().toISOString();
    const diff: WeaveDiff = {
      id: "draft",
      baseGraphVersion: 1,
      originatorActorId: "human:owner",
      sourceMessageId: "message-compose-agent",
      intentSummary: "Add a bounded research Agent",
      workTitle: "Compose research Agent",
      acceptanceCriteria: ["Agent has an immutable harness"],
      stewardExplanation: "This changes the production graph, not repository files.",
      executionDraft: { executorActorId: "agent:claude", repositoryId: "repo:demo", testCommandId: "test:npm", requiredEvidence: ["execution-summary"] },
      operations: [
        {
          operationId: "add-research-agent",
          op: "add_node",
          explanation: "Create the Graph-native research Actor",
          node: {
            id: "agent:native:research",
            name: "Research Agent",
            type: "actor",
            kind: "agent",
            source: "graph-native",
            adapterKind: "claude-code",
            lifecycle: "flow-scoped",
            status: "online",
            harnessPrompt: "Research the assigned question and report evidence.",
            skills: ["evidence-first"],
            tools: ["Read", "Glob", "Grep"],
            canOrchestrate: false,
            createdAt: now,
            updatedAt: now,
          },
        },
        { operationId: "delegate-research", op: "add_edge", explanation: "Delegate to the new Agent", edge: { id: "edge:delegate:research", type: "delegation", from: "agent:steward", to: "agent:native:research" } },
      ],
    };
    const service = new ApplicationService(store, new StaticSteward({ kind: "weave_diff", diff }), executor, {
      repositoryId: "repo:demo",
      executorActorId: "agent:claude",
      ownerActorId: "human:owner",
      stewardActorId: "agent:steward",
      testCommandId: "test:npm",
      testCommandArgv: ["npm", "test"],
    });
    await service.initialize();
    diff.baseGraphVersion = service.getProjection().graph.version;
    const result = await service.submitIntent({ messageId: diff.sourceMessageId, channel: "web", conversationId: "web:owner", actorId: "human:owner", text: diff.intentSummary });
    if (result.kind !== "weave_diff") throw new Error("expected weave diff");
    await service.approveMutation(result.mutation.id, "human:owner", "approve-native-agent");

    const profile = service.getProjection().agents["agent:native:research"];
    expect(profile?.source).toBe("graph-native");
    expect(profile?.parentAgentId).toBe("agent:steward");
    expect(profile?.specVersionId && service.getProjection().agentSpecs[profile.specVersionId]?.prompt).toContain("Research the assigned question");
    expect(executor.executions).toBe(0);
    expect(Object.values(service.getProjection().runs)).toHaveLength(0);
    store.close();
  });

  it("executes a typed runtime command through the deterministic Control Plane", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const service = new ApplicationService(store, new StaticSteward({
      kind: "command", text: "已打开历史记录。", reasoningSummary: "这是对已存在资源的读取命令。",
      command: { action: "open-resource", target: { kind: "history", id: "history:all", label: "History" }, arguments: {} },
    }), new FakeExecutor(), { repositoryId: "repo:demo", executorActorId: "agent:claude", ownerActorId: "human:owner", stewardActorId: "agent:steward", testCommandId: "test:npm", testCommandArgv: ["npm", "test"] });
    await service.initialize();
    service.setStewardControlPlane(new ControlPlane(store, { executeCommand: async (command) => command.target, applyChange: async () => ({}) }));
    const result = await service.submitIntent({ messageId: "message-command", channel: "web", conversationId: "web:owner", actorId: "human:owner", text: "打开历史" });
    expect(result.kind).toBe("command");
    expect(store.getProjection().commands[Object.keys(store.getProjection().commands)[0]!]?.status).toBe("succeeded");
    store.close();
  });

  it("turns a durable Steward plan into a risk-classified ChangeSet", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const service = new ApplicationService(store, new StaticSteward({
      kind: "changeset", text: "我整理了一个待审批的 WorkerSpec 发布。", reasoningSummary: "发布 Harness 是持久且高风险的定义变更。",
      changeSet: { title: "发布 Reviewer v2", intentSummary: "更新 Reviewer Harness", operations: [{ id: "publish", kind: "publish-worker-spec", targetId: "worker:reviewer", dependsOn: [], payload: { lifecycle: "persistent" } }], preconditions: [] },
    }), new FakeExecutor(), { repositoryId: "repo:demo", executorActorId: "agent:claude", ownerActorId: "human:owner", stewardActorId: "agent:steward", testCommandId: "test:npm", testCommandArgv: ["npm", "test"] });
    await service.initialize();
    service.setStewardControlPlane(new ControlPlane(store, { executeCommand: async () => ({}), applyChange: async () => ({}) }));
    const result = await service.submitIntent({ messageId: "message-changeset", channel: "web", conversationId: "web:owner", actorId: "human:owner", text: "发布 Reviewer 新配置" });
    if (result.kind !== "changeset") throw new Error("expected ChangeSet");
    expect(result.changeSet).toMatchObject({ aggregateRisk: "red", status: "awaiting-approval" });
    expect(result.block.changeSetId).toBe(result.changeSet.id);
    store.close();
  });

  it("turns a malformed ChangeSet into one safe clarification instead of a request failure", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const steward: StewardPort = {
      respond: async () => ({
        kind: "changeset", text: "待审批变更", reasoningSummary: "需要持久化变更。",
        changeSet: { title: "无效流程", intentSummary: "创建流程", operations: [{ id: "create", kind: "create-flow", dependsOn: [], payload: { description: "missing fields" } }], preconditions: [] },
      }),
      repair: async () => { throw new Error("repair model temporarily unavailable"); },
    };
    const service = new ApplicationService(store, steward, new FakeExecutor(), { repositoryId: "repo:demo", executorActorId: "agent:claude", ownerActorId: "human:owner", stewardActorId: "agent:steward", testCommandId: "test:npm", testCommandArgv: ["npm", "test"] });
    await service.initialize();
    service.setStewardControlPlane(new ControlPlane(store, {
      executeCommand: async () => ({}),
      applyChange: async () => ({}),
      validateChange: async () => { throw new Error("create-flow payload contains a private absolute path and invalid fields"); },
    }));

    const result = await service.submitIntent({ messageId: "message-invalid-changeset", channel: "web", conversationId: "web:owner", actorId: "human:owner", text: "创建流程" });

    expect(result.kind).toBe("clarification");
    expect(store.readAll().filter((event) => event.eventType === "ChangeSetEvent")).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("private absolute path");
    expect(JSON.stringify(result)).not.toContain("repair model temporarily unavailable");
    store.close();
  });

  it("does not misclassify ChangeSet persistence failures as repairable validation", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const service = new ApplicationService(store, new StaticSteward({
      kind: "changeset", text: "待审批变更", reasoningSummary: "持久化流程。",
      changeSet: { title: "流程", intentSummary: "创建流程", operations: [{ id: "create", kind: "create-flow", dependsOn: [], payload: { name: "Valid", steps: [{ id: "review", name: "Review", actorId: "agent:claude" }] } }], preconditions: [] },
    }), new FakeExecutor(), { repositoryId: "repo:demo", executorActorId: "agent:claude", ownerActorId: "human:owner", stewardActorId: "agent:steward", testCommandId: "test:npm", testCommandArgv: ["npm", "test"] });
    await service.initialize();
    service.setStewardControlPlane({
      executeCommand: async (command) => command,
      proposeChangeSet: async () => { throw new Error("ledger unavailable"); },
    });

    await expect(service.submitIntent({ messageId: "message-ledger-failure", channel: "web", conversationId: "web:owner", actorId: "human:owner", text: "创建流程" })).rejects.toThrow(/ledger unavailable/i);
    store.close();
  });

  it("repairs an invalid ChangeSet once before presenting an approvable card", async () => {
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const steward: StewardPort = {
      respond: async () => ({ kind: "changeset", text: "初始变更", reasoningSummary: "持久化流程。", changeSet: { title: "流程", intentSummary: "创建流程", operations: [{ id: "invalid", kind: "create-flow", dependsOn: [], payload: { name: "Invalid", steps: [{ id: "review", name: "Review", actorId: "missing" }] } }], preconditions: [] } }),
      repair: async () => ({ kind: "changeset", text: "已修正资源引用。", reasoningSummary: "使用已注册 Actor。", changeSet: { title: "流程", intentSummary: "创建流程", operations: [{ id: "valid", kind: "create-flow", dependsOn: [], payload: { name: "Valid", steps: [{ id: "review", name: "Review", actorId: "agent:claude" }] } }], preconditions: [] } }),
    };
    const service = new ApplicationService(store, steward, new FakeExecutor(), { repositoryId: "repo:demo", executorActorId: "agent:claude", ownerActorId: "human:owner", stewardActorId: "agent:steward", testCommandId: "test:npm", testCommandArgv: ["npm", "test"] });
    await service.initialize();
    service.setStewardControlPlane(new ControlPlane(store, {
      executeCommand: async () => ({}), applyChange: async () => ({}),
      validateChange: async (operation) => { if (operation.id === "invalid") throw new Error("unknown absolute resource path"); },
    }));

    const result = await service.submitIntent({ messageId: "message-repaired-changeset", channel: "web", conversationId: "web:owner", actorId: "human:owner", text: "创建流程" });

    expect(result.kind).toBe("changeset");
    if (result.kind !== "changeset") throw new Error("expected ChangeSet");
    expect(result.changeSet.operations[0]?.id).toBe("valid");
    expect(result.block.text).toBe("已修正资源引用。");
    expect(JSON.stringify(result)).not.toContain("absolute resource path");
    store.close();
  });

  it("uses an injected clock for application events and graph projections", async () => {
    const fixedTime = "2027-04-20T14:30:00.000Z";
    const store = new SqliteEventStore(":memory:", emptyProjection(), reduceProjection);
    const service = new ApplicationService(
      store,
      new StaticSteward({ kind: "answer", text: "Ready", reasoningSummary: "Fixture response" }),
      new FakeExecutor(),
      {
        repositoryId: "repo:demo",
        executorActorId: "agent:claude",
        ownerActorId: "human:owner",
        stewardActorId: "agent:steward",
        testCommandId: "test:npm",
        testCommandArgv: ["npm", "test"],
      },
      undefined,
      { now: () => new Date(fixedTime) },
    );

    await service.initialize();
    await service.submitIntent({
      messageId: "message-fixed-clock",
      channel: "web",
      conversationId: "web:owner",
      actorId: "human:owner",
      text: "Status?",
    });

    expect(new Set(service.readLedger().map((event) => event.occurredAt))).toEqual(new Set([fixedTime]));
    expect(service.getProjection().graph.nodes.every((node) => node.createdAt === fixedTime && node.updatedAt === fixedTime)).toBe(true);
    store.close();
  });
});
