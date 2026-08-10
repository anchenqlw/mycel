import type {
  AgentStepExecutionResult,
  CollaborationChange,
  FlowBudget,
  FlowDefinition,
  FlowRun,
  FlowStepDefinition,
  HumanTask,
  PermissionLease,
  PermissionRequest,
  StepAttempt,
  StepResult,
  StepRun,
} from "@mycel/domain";
import { ulid } from "ulid";

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
const DEFAULT_MAX_TOTAL_ATTEMPTS = 100;

export interface RestoredFlowRuntime {
  runs: FlowRun[];
  stepRuns: StepRun[];
  stepAttempts: StepAttempt[];
  stepResults: StepResult[];
  humanTasks: HumanTask[];
  permissionLeases: PermissionLease[];
  permissionRequests: PermissionRequest[];
}

export interface AgentStepInput {
  flow: FlowDefinition;
  run: FlowRun;
  step: FlowStepDefinition;
  stepRun: StepRun;
  attempt: StepAttempt;
  dependencyResults: StepResult[];
  permissionLease: PermissionLease;
  prompt: string;
}

export interface FlowEnginePort {
  persistDefinition(flow: FlowDefinition): Promise<void>;
  persistRun(run: FlowRun, message: string): Promise<void>;
  persistCollaboration(change: CollaborationChange, message: string, idempotencyKey: string): Promise<void>;
  executeAgentStep(input: AgentStepInput): Promise<AgentStepExecutionResult>;
  cancelAgentStep?(attempt: StepAttempt): Promise<void>;
  actorCapabilities(actorId: string): string[];
  actorCapacity(actorId: string): number;
}

export interface FlowClock {
  now(): Date;
}

const systemFlowClock: FlowClock = {
  now: () => new Date(),
};

interface RuntimeState {
  run: FlowRun;
  flow: FlowDefinition;
  stepRuns: Map<string, StepRun>;
  attempts: Map<string, StepAttempt>;
  results: Map<string, StepResult>;
  humanTasks: Map<string, HumanTask>;
  leases: Map<string, PermissionLease>;
  permissionRequests: Map<string, PermissionRequest>;
  active: Map<string, Promise<void>>;
}

type StepEvaluation =
  | { kind: "waiting" }
  | { kind: "ready"; selected: StepRun[] }
  | { kind: "skip"; selected: StepRun[]; reason: string };

export class LocalFlowEngine {
  readonly #port: FlowEnginePort;
  readonly #clock: FlowClock;
  readonly #flows = new Map<string, FlowDefinition>();
  readonly #states = new Map<string, RuntimeState>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #drivers = new Map<string, Promise<FlowRun>>();

  constructor(port: FlowEnginePort, clock: FlowClock = systemFlowClock) {
    this.#port = port;
    this.#clock = clock;
  }

  restore(flows: Iterable<FlowDefinition>, runtime?: RestoredFlowRuntime): void {
    for (const flow of flows) {
      const normalized = normalizeFlow(flow);
      this.#flows.set(normalized.id, normalized);
      this.#schedule(normalized);
    }
    if (!runtime) return;
    for (const run of runtime.runs) {
      const flow = run.flowSnapshot ? normalizeFlow(run.flowSnapshot) : this.#flows.get(run.flowId);
      if (!flow) continue;
      const state: RuntimeState = {
        run: normalizeRun(run),
        flow,
        stepRuns: indexBy(runtime.stepRuns.filter((item) => item.flowRunId === run.id)),
        attempts: indexBy(runtime.stepAttempts.filter((item) => runtime.stepRuns.some((stepRun) => stepRun.flowRunId === run.id && stepRun.id === item.stepRunId))),
        results: indexBy(runtime.stepResults.filter((item) => item.flowRunId === run.id)),
        humanTasks: indexBy(runtime.humanTasks.filter((item) => item.flowRunId === run.id)),
        leases: indexBy(runtime.permissionLeases.filter((item) => item.flowRunId === run.id)),
        permissionRequests: indexBy(runtime.permissionRequests.filter((item) => item.flowRunId === run.id)),
        active: new Map(),
      };
      this.#states.set(run.id, state);
      if (!isRunTerminal(state.run.phase)) {
        const driver = this.#recoverAndDrive(state).finally(() => this.#drivers.delete(state.run.id));
        this.#drivers.set(state.run.id, driver);
      }
    }
  }

  list(): FlowDefinition[] {
    return [...this.#flows.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async save(input: Omit<FlowDefinition, "createdAt" | "updatedAt"> & { createdAt?: string }): Promise<FlowDefinition> {
    const normalized = normalizeFlow(input as FlowDefinition);
    validateFlow(normalized);
    const now = this.#now();
    const previous = this.#flows.get(input.id);
    const flow: FlowDefinition = {
      ...normalized,
      createdAt: previous?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    };
    this.#flows.set(flow.id, flow);
    this.#schedule(flow);
    await this.#port.persistDefinition(flow);
    return flow;
  }

  async publish(flowId: string): Promise<FlowDefinition> {
    const previous = requiredFlow(this.#flows, flowId);
    return this.save({ ...previous, version: previous.status === "published" ? previous.version + 1 : Math.max(1, previous.version), status: "published" });
  }

  async pause(flowId: string): Promise<FlowDefinition> {
    const previous = requiredFlow(this.#flows, flowId);
    return this.save({ ...previous, status: "paused" });
  }

  async trigger(flowId: string, triggerKind: FlowRun["triggerKind"] = "manual"): Promise<FlowRun> {
    const flow = requiredFlow(this.#flows, flowId);
    if (flow.status !== "published") throw new Error(`flow is not published: ${flowId}`);
    const now = this.#now();
    const run: FlowRun = {
      id: `flowrun_${ulid()}`,
      flowId: flow.id,
      flowVersion: flow.version,
      phase: "queued",
      triggerKind,
      flowSnapshot: flow,
      currentStepIds: [],
      completedStepIds: [],
      failedStepIds: [],
      skippedStepIds: [],
      blockedStepIds: [],
      totalAttempts: 0,
      message: "Flow run queued",
      createdAt: now,
      updatedAt: now,
    };
    const state: RuntimeState = {
      run,
      flow,
      stepRuns: new Map(),
      attempts: new Map(),
      results: new Map(),
      humanTasks: new Map(),
      leases: new Map(),
      permissionRequests: new Map(),
      active: new Map(),
    };
    this.#states.set(run.id, state);
    await this.#port.persistRun(run, "Flow run queued");
    for (const step of flow.steps) {
      const stepRun: StepRun = {
        id: stepRunId(run.id, step.id),
        flowRunId: run.id,
        stepId: step.id,
        actorId: step.actorId,
        phase: "pending",
        selectedDependencyStepRunIds: [],
        message: "Waiting for dependencies",
        createdAt: now,
        updatedAt: now,
      };
      state.stepRuns.set(stepRun.id, stepRun);
      await this.#persist({ kind: "step-run", entity: stepRun }, "Step created", `step-run:create:${stepRun.id}`);
    }
    this.#startDriver(state);
    return run;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.#drivers.values()]);
  }

  details(runId: string): RestoredFlowRuntime {
    const state = requiredState(this.#states, runId);
    return {
      runs: [state.run],
      stepRuns: [...state.stepRuns.values()],
      stepAttempts: [...state.attempts.values()],
      stepResults: [...state.results.values()],
      humanTasks: [...state.humanTasks.values()],
      permissionLeases: [...state.leases.values()],
      permissionRequests: [...state.permissionRequests.values()],
    };
  }

  async claimHumanTask(taskId: string, actorId: string, idempotencyKey: string): Promise<HumanTask> {
    const { state, task } = this.#findHumanTask(taskId);
    if (task.phase === "claimed" && task.claimedByActorId === actorId) return task;
    if (task.phase !== "open") throw new Error(`human task cannot be claimed from ${task.phase}`);
    if (actorId !== task.assignedActorId && actorId !== "human:owner") throw new Error(`human task is assigned to ${task.assignedActorId}`);
    const updated = this.#touch({ ...task, phase: "claimed" as const, claimedByActorId: actorId });
    state.humanTasks.set(updated.id, updated);
    await this.#persist({ kind: "human-task", entity: updated }, `Claimed by ${actorId}`, `${idempotencyKey}:claim`);
    await this.#refreshRun(state, "Human task claimed");
    return updated;
  }

  async releaseHumanTask(taskId: string, actorId: string, idempotencyKey: string): Promise<HumanTask> {
    const { state, task } = this.#findHumanTask(taskId);
    if (task.phase !== "claimed") throw new Error(`human task cannot be released from ${task.phase}`);
    if (actorId !== task.claimedByActorId && actorId !== "human:owner") throw new Error("only the claimant or owner can release this task");
    const { claimedByActorId: _claimed, ...rest } = task;
    const updated = this.#touch({ ...rest, phase: "open" as const });
    state.humanTasks.set(updated.id, updated);
    await this.#persist({ kind: "human-task", entity: updated }, `Released by ${actorId}`, `${idempotencyKey}:release`);
    await this.#refreshRun(state, "Human task released");
    return updated;
  }

  async reassignHumanTask(taskId: string, actorId: string, assignedActorId: string, idempotencyKey: string): Promise<HumanTask> {
    const { state, task } = this.#findHumanTask(taskId);
    if (task.phase !== "open" && task.phase !== "claimed") throw new Error(`human task cannot be reassigned from ${task.phase}`);
    if (actorId !== task.assignedActorId && actorId !== task.claimedByActorId && actorId !== "human:owner") throw new Error("only the assignee, claimant, or owner can reassign this task");
    const { claimedByActorId: _claimed, ...rest } = task;
    const updated = this.#touch({ ...rest, assignedActorId, phase: "open" as const });
    state.humanTasks.set(updated.id, updated);
    const stepRun = state.stepRuns.get(task.stepRunId);
    if (stepRun) {
      const reassigned = this.#touch({ ...stepRun, actorId: assignedActorId, message: `Reassigned to ${assignedActorId}` });
      state.stepRuns.set(reassigned.id, reassigned);
      await this.#persist({ kind: "step-run", entity: reassigned }, reassigned.message, `${idempotencyKey}:step-run`);
    }
    await this.#persist({ kind: "human-task", entity: updated }, `Reassigned to ${assignedActorId}`, `${idempotencyKey}:reassign`);
    return updated;
  }

  async completeHumanTask(
    taskId: string,
    actorId: string,
    input: { summary: string; output?: unknown; artifacts?: StepResult["artifacts"] },
    idempotencyKey: string,
  ): Promise<HumanTask> {
    const { state, task } = this.#findHumanTask(taskId);
    if (task.phase === "completed") return task;
    if (task.phase !== "claimed") throw new Error(`human task must be claimed before completion`);
    if (actorId !== task.claimedByActorId && actorId !== "human:owner") throw new Error("only the claimant or owner can complete this task");
    const attempt = requiredItem(state.attempts, task.attemptId, "step attempt");
    const stepRun = requiredItem(state.stepRuns, task.stepRunId, "step run");
    const now = this.#now();
    const result: StepResult = {
      id: `stepresult_${ulid()}`,
      flowRunId: task.flowRunId,
      stepRunId: task.stepRunId,
      attemptId: task.attemptId,
      producerActorId: actorId,
      status: "completed",
      summary: input.summary,
      output: input.output ?? {},
      artifacts: input.artifacts ?? [],
      startedAt: attempt.startedAt,
      completedAt: now,
    };
    const completedTask = { ...task, phase: "completed" as const, updatedAt: now };
    const completedAttempt = { ...attempt, phase: "completed" as const, producerActorId: actorId, completedAt: now };
    const { activeAttemptId: _activeAttempt, ...stepWithoutActive } = stepRun;
    const completedStep = { ...stepWithoutActive, phase: "completed" as const, resultId: result.id, message: input.summary, updatedAt: now };
    state.results.set(result.id, result);
    state.humanTasks.set(task.id, completedTask);
    state.attempts.set(attempt.id, completedAttempt);
    state.stepRuns.set(stepRun.id, completedStep);
    await this.#persist({ kind: "step-result", entity: result }, input.summary, `${idempotencyKey}:result`);
    await this.#persist({ kind: "step-attempt", entity: completedAttempt }, "Human attempt completed", `${idempotencyKey}:attempt`);
    await this.#persist({ kind: "step-run", entity: completedStep }, input.summary, `${idempotencyKey}:step-run`);
    await this.#persist({ kind: "human-task", entity: completedTask }, input.summary, `${idempotencyKey}:task`);
    this.#startDriver(state);
    return completedTask;
  }

  async failHumanTask(taskId: string, actorId: string, reason: string, idempotencyKey: string): Promise<HumanTask> {
    const { state, task } = this.#findHumanTask(taskId);
    if (task.phase !== "claimed") throw new Error("human task must be claimed before failure");
    if (actorId !== task.claimedByActorId && actorId !== "human:owner") throw new Error("only the claimant or owner can fail this task");
    const attempt = requiredItem(state.attempts, task.attemptId, "step attempt");
    const stepRun = requiredItem(state.stepRuns, task.stepRunId, "step run");
    const step = requiredStep(state.flow, stepRun.stepId);
    const now = this.#now();
    const result: StepResult = {
      id: `stepresult_${ulid()}`,
      flowRunId: task.flowRunId,
      stepRunId: task.stepRunId,
      attemptId: task.attemptId,
      producerActorId: actorId,
      status: "failed",
      summary: reason,
      output: {},
      artifacts: [],
      error: reason,
      startedAt: attempt.startedAt,
      completedAt: now,
    };
    const failedTask = { ...task, phase: "failed" as const, updatedAt: now };
    const failedAttempt = { ...attempt, phase: "failed" as const, producerActorId: actorId, error: reason, completedAt: now };
    const retry = attempt.ordinal < step.maxAttempts && this.#withinAttemptBudget(state);
    const { activeAttemptId: _activeAttempt, ...stepWithoutActive } = stepRun;
    const { resultId: _previousResult, ...stepWithoutResult } = stepWithoutActive;
    const failedStep: StepRun = retry
      ? { ...stepWithoutResult, phase: "pending", message: `Retrying after human failure: ${reason}`, updatedAt: now }
      : { ...stepWithoutResult, phase: "failed", resultId: result.id, message: reason, updatedAt: now };
    state.results.set(result.id, result);
    state.humanTasks.set(task.id, failedTask);
    state.attempts.set(attempt.id, failedAttempt);
    state.stepRuns.set(stepRun.id, failedStep);
    await this.#persist({ kind: "step-result", entity: result }, reason, `${idempotencyKey}:result`);
    await this.#persist({ kind: "step-attempt", entity: failedAttempt }, reason, `${idempotencyKey}:attempt`);
    await this.#persist({ kind: "step-run", entity: failedStep }, failedStep.message, `${idempotencyKey}:step-run`);
    await this.#persist({ kind: "human-task", entity: failedTask }, reason, `${idempotencyKey}:task`);
    this.#startDriver(state);
    return failedTask;
  }

  async resume(runId: string): Promise<FlowRun> {
    const state = requiredState(this.#states, runId);
    for (const stepRun of state.stepRuns.values()) {
      if (stepRun.phase !== "blocked") continue;
      const hasOpenHumanTask = [...state.humanTasks.values()].some((task) => task.stepRunId === stepRun.id && (task.phase === "open" || task.phase === "claimed"));
      const hasPermissionRequest = [...state.permissionRequests.values()].some((request) => request.stepRunId === stepRun.id && request.phase === "open");
      if (!hasOpenHumanTask && !hasPermissionRequest) {
        const pending = this.#touch({ ...stepRun, phase: "pending" as const, message: "Resuming blocked step" });
        state.stepRuns.set(pending.id, pending);
        await this.#persist({ kind: "step-run", entity: pending }, pending.message, `resume:${runId}:${pending.id}:${pending.updatedAt}`);
      }
    }
    this.#startDriver(state);
    return state.run;
  }

  async retryStep(stepRunIdValue: string, actorId?: string): Promise<StepRun> {
    const state = [...this.#states.values()].find((candidate) => candidate.stepRuns.has(stepRunIdValue));
    if (!state) throw new Error(`step run not found: ${stepRunIdValue}`);
    const stepRun = requiredItem(state.stepRuns, stepRunIdValue, "step run");
    if (stepRun.phase !== "failed" && stepRun.phase !== "blocked") throw new Error(`step run cannot be retried from ${stepRun.phase}`);
    if (!this.#withinAttemptBudget(state)) throw new Error("Flow retry budget is exhausted");
    const { activeAttemptId: _activeAttempt, resultId: _previousResult, ...stepWithoutActive } = stepRun;
    const updated = this.#touch({ ...stepWithoutActive, ...(actorId ? { actorId } : {}), phase: "pending" as const, message: actorId ? `Retrying with ${actorId}` : "Retry requested" });
    state.stepRuns.set(updated.id, updated);
    await this.#persist({ kind: "step-run", entity: updated }, updated.message, `retry:${updated.id}:${updated.updatedAt}`);
    await this.#refreshRun(state, updated.message);
    this.#startDriver(state);
    return updated;
  }

  async approvePermissionRequest(requestId: string, actorId: string, idempotencyKey: string): Promise<PermissionRequest> {
    const { state, request } = this.#findPermissionRequest(requestId);
    if (request.phase === "approved") return request;
    if (request.phase !== "open") throw new Error(`permission request cannot be approved from ${request.phase}`);
    if (actorId !== "human:owner") throw new Error("only the local owner can approve a permission request");
    const outsideCeiling = request.requestedCapabilities.filter((capability) => !state.flow.permissionCeiling.includes(capability));
    if (outsideCeiling.length > 0) throw new Error(`permission exceeds Flow ceiling: ${outsideCeiling.join(", ")}`);
    const approved = this.#touch({ ...request, phase: "approved" as const });
    state.permissionRequests.set(approved.id, approved);
    await this.#persist({ kind: "permission-request", entity: approved }, `Approved by ${actorId}`, `${idempotencyKey}:approve`);
    const stepRun = requiredItem(state.stepRuns, request.stepRunId, "step run");
    if (stepRun.phase === "blocked") {
      const pending = this.#touch({ ...stepRun, phase: "pending" as const, message: "Permission approved; resuming" });
      state.stepRuns.set(pending.id, pending);
      await this.#persist({ kind: "step-run", entity: pending }, pending.message, `${idempotencyKey}:step-run`);
    }
    this.#startDriver(state);
    return approved;
  }

  async denyPermissionRequest(requestId: string, actorId: string, reason: string, idempotencyKey: string): Promise<PermissionRequest> {
    const { state, request } = this.#findPermissionRequest(requestId);
    if (request.phase === "denied") return request;
    if (request.phase !== "open") throw new Error(`permission request cannot be denied from ${request.phase}`);
    if (actorId !== "human:owner") throw new Error("only the local owner can deny a permission request");
    const denied = this.#touch({ ...request, phase: "denied" as const, reason: `${request.reason}; denied: ${reason}` });
    state.permissionRequests.set(denied.id, denied);
    await this.#persist({ kind: "permission-request", entity: denied }, reason, `${idempotencyKey}:deny`);
    const stepRun = requiredItem(state.stepRuns, request.stepRunId, "step run");
    const failed = this.#touch({ ...stepRun, phase: "failed" as const, message: `Permission denied: ${reason}` });
    state.stepRuns.set(failed.id, failed);
    await this.#persist({ kind: "step-run", entity: failed }, failed.message, `${idempotencyKey}:step-run`);
    this.#startDriver(state);
    return denied;
  }

  async cancel(runId: string): Promise<FlowRun> {
    const state = requiredState(this.#states, runId);
    if (isRunTerminal(state.run.phase)) return state.run;
    for (const task of state.humanTasks.values()) {
      if (task.phase !== "open" && task.phase !== "claimed") continue;
      const cancelled = this.#touch({ ...task, phase: "cancelled" as const });
      state.humanTasks.set(cancelled.id, cancelled);
      await this.#persist({ kind: "human-task", entity: cancelled }, "Run cancelled", `cancel:${runId}:task:${task.id}`);
    }
    for (const stepRun of state.stepRuns.values()) {
      if (isStepTerminal(stepRun.phase)) continue;
      const attempt = stepRun.activeAttemptId ? state.attempts.get(stepRun.activeAttemptId) : undefined;
      if (attempt) await this.#port.cancelAgentStep?.(attempt);
      const cancelled = this.#touch({ ...stepRun, phase: "cancelled" as const, message: "Run cancelled" });
      state.stepRuns.set(cancelled.id, cancelled);
      await this.#persist({ kind: "step-run", entity: cancelled }, cancelled.message, `cancel:${runId}:step:${stepRun.id}`);
    }
    state.run = this.#updateRun(state.run, { phase: "canceled", currentStepIds: [], message: "Flow run canceled" });
    await this.#port.persistRun(state.run, state.run.message ?? "Flow run canceled");
    return state.run;
  }

  stop(): void {
    for (const timer of this.#timers.values()) clearInterval(timer);
    this.#timers.clear();
  }

  async #recoverAndDrive(state: RuntimeState): Promise<FlowRun> {
    for (const attempt of state.attempts.values()) {
      if (attempt.phase !== "starting" && attempt.phase !== "running") continue;
      const interrupted = { ...attempt, phase: "interrupted" as const, error: "Runtime restarted while attempt was active", completedAt: this.#now() };
      state.attempts.set(interrupted.id, interrupted);
      await this.#persist({ kind: "step-attempt", entity: interrupted }, interrupted.error, `recover:attempt:${interrupted.id}`);
      const stepRun = state.stepRuns.get(interrupted.stepRunId);
      if (stepRun && !isStepTerminal(stepRun.phase)) {
        const pending = this.#touch({ ...stepRun, phase: "pending" as const, message: "Recovering interrupted attempt" });
        state.stepRuns.set(pending.id, pending);
        await this.#persist({ kind: "step-run", entity: pending }, pending.message, `recover:step:${pending.id}:${interrupted.ordinal}`);
      }
    }
    return this.#drive(state);
  }

  #startDriver(state: RuntimeState): void {
    if (this.#drivers.has(state.run.id)) return;
    const driver = this.#drive(state).finally(() => this.#drivers.delete(state.run.id));
    this.#drivers.set(state.run.id, driver);
  }

  async #drive(state: RuntimeState): Promise<FlowRun> {
    if (isRunTerminal(state.run.phase)) return state.run;
    if (state.run.phase === "queued" || state.run.phase === "blocked") {
      state.run = this.#updateRun(state.run, { phase: "running", message: "Flow scheduler running" });
      await this.#port.persistRun(state.run, state.run.message ?? "Flow scheduler running");
    }

    while (!isRunTerminal(state.run.phase)) {
      let changed = false;
      for (const step of state.flow.steps) {
        const stepRun = requiredItem(state.stepRuns, stepRunId(state.run.id, step.id), "step run");
        if (stepRun.phase !== "pending") continue;
        const evaluation = evaluateStep(state, step);
        if (evaluation.kind === "waiting") continue;
        if (evaluation.kind === "skip") {
          await this.#skipStep(state, stepRun, evaluation.selected, evaluation.reason);
          changed = true;
          continue;
        }
        const ready = this.#touch({ ...stepRun, phase: "ready" as const, selectedDependencyStepRunIds: evaluation.selected.map((item) => item.id), message: "Dependencies satisfied" });
        state.stepRuns.set(ready.id, ready);
        await this.#persist({ kind: "step-run", entity: ready }, ready.message, `ready:${ready.id}:${ready.selectedDependencyStepRunIds.join(",") || "root"}`);
        changed = true;
      }

      const readyHuman = state.flow.steps.filter((step) => step.kind === "human" && requiredItem(state.stepRuns, stepRunId(state.run.id, step.id), "step run").phase === "ready");
      for (const step of readyHuman) {
        await this.#dispatchHuman(state, step);
        changed = true;
      }

      const runningAgentCount = [...state.stepRuns.values()].filter((item) => item.phase === "running" && requiredStep(state.flow, item.stepId).kind === "agent").length;
      let slots = Math.max(0, (state.flow.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY) - runningAgentCount);
      const readyAgents = state.flow.steps.filter((step) => step.kind === "agent" && requiredItem(state.stepRuns, stepRunId(state.run.id, step.id), "step run").phase === "ready");
      for (const step of readyAgents) {
        if (slots <= 0) break;
        const actorRunning = [...state.stepRuns.values()].filter((item) => item.actorId === step.actorId && item.phase === "running").length;
        if (actorRunning >= Math.max(1, this.#port.actorCapacity(step.actorId))) continue;
        if (!this.#withinAttemptBudget(state)) break;
        const task = this.#dispatchAgent(state, step);
        state.active.set(step.id, task.finally(() => state.active.delete(step.id)));
        slots -= 1;
        changed = true;
      }

      await this.#refreshRun(state, changed ? "Scheduler advanced" : "Scheduler waiting");
      if (isRunTerminal(state.run.phase) || state.run.phase === "blocked") break;
      if (state.active.size > 0) {
        await Promise.race(state.active.values());
        continue;
      }
      if (!changed) {
        state.run = this.#updateRun(state.run, { phase: "failed", message: "Flow graph cannot make progress" });
        await this.#port.persistRun(state.run, state.run.message ?? "Flow graph cannot make progress");
        break;
      }
    }
    return state.run;
  }

  async #dispatchHuman(state: RuntimeState, step: FlowStepDefinition): Promise<void> {
    const stepRun = requiredItem(state.stepRuns, stepRunId(state.run.id, step.id), "step run");
    const ordinal = attemptsFor(state, stepRun.id).length + 1;
    const lease = await this.#createLease(state, stepRun, step, ordinal);
    if (!lease) return;
    const now = this.#now();
    const attempt: StepAttempt = {
      id: `attempt_${ulid()}`,
      stepRunId: stepRun.id,
      ordinal,
      phase: "blocked",
      requestedActorId: stepRun.actorId,
      permissionLeaseId: lease.id,
      startedAt: now,
    };
    const task: HumanTask = {
      id: `humantask_${ulid()}`,
      flowRunId: state.run.id,
      stepRunId: stepRun.id,
      attemptId: attempt.id,
      assignedActorId: stepRun.actorId,
      phase: "open",
      instructions: step.prompt,
      dependencyResultIds: dependencyResults(state, stepRun).map((item) => item.id),
      createdAt: now,
      updatedAt: now,
    };
    attempt.humanTaskId = task.id;
    const blocked = { ...stepRun, phase: "blocked" as const, activeAttemptId: attempt.id, message: `Waiting for ${task.assignedActorId}`, updatedAt: now };
    state.attempts.set(attempt.id, attempt);
    state.humanTasks.set(task.id, task);
    state.stepRuns.set(blocked.id, blocked);
    state.run = this.#updateRun(state.run, { totalAttempts: (state.run.totalAttempts ?? 0) + 1 });
    await this.#port.persistRun(state.run, `Human attempt ${ordinal} created for ${step.name}`);
    await this.#persist({ kind: "step-attempt", entity: attempt }, blocked.message, `attempt:create:${attempt.id}`);
    await this.#persist({ kind: "human-task", entity: task }, blocked.message, `human-task:create:${task.id}`);
    await this.#persist({ kind: "step-run", entity: blocked }, blocked.message, `step-blocked:${blocked.id}:${attempt.id}`);
  }

  async #dispatchAgent(state: RuntimeState, step: FlowStepDefinition): Promise<void> {
    const stepRun = requiredItem(state.stepRuns, stepRunId(state.run.id, step.id), "step run");
    const ordinal = attemptsFor(state, stepRun.id).length + 1;
    const lease = await this.#createLease(state, stepRun, step, ordinal);
    if (!lease) return;
    const now = this.#now();
    const attempt: StepAttempt = {
      id: `attempt_${ulid()}`,
      stepRunId: stepRun.id,
      ordinal,
      phase: "running",
      requestedActorId: stepRun.actorId,
      permissionLeaseId: lease.id,
      startedAt: now,
    };
    const { resultId: _previousResult, ...stepWithoutResult } = stepRun;
    const running = { ...stepWithoutResult, phase: "running" as const, activeAttemptId: attempt.id, message: `Attempt ${ordinal} running`, updatedAt: now };
    state.attempts.set(attempt.id, attempt);
    state.stepRuns.set(running.id, running);
    state.run = this.#updateRun(state.run, { totalAttempts: (state.run.totalAttempts ?? 0) + 1 });
    await this.#port.persistRun(state.run, `Agent attempt ${ordinal} started for ${step.name}`);
    await this.#persist({ kind: "step-attempt", entity: attempt }, running.message, `attempt:create:${attempt.id}`);
    await this.#persist({ kind: "step-run", entity: running }, running.message, `step-running:${running.id}:${attempt.id}`);
    const dependencies = dependencyResults(state, running);
    const prompt = assembleStepPrompt(state.flow, state.run, step, running, dependencies, lease);
    let outcome: AgentStepExecutionResult;
    try {
      outcome = await withTimeout(this.#port.executeAgentStep({ flow: state.flow, run: state.run, step, stepRun: running, attempt, dependencyResults: dependencies, permissionLease: lease, prompt }), step.timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { status: "failed", summary: message, error: message };
    }
    const latestStepRun = requiredItem(state.stepRuns, running.id, "step run");
    if (latestStepRun.phase === "cancelled") return;
    const completedAt = this.#now();
    const result: StepResult = {
      id: `stepresult_${ulid()}`,
      flowRunId: state.run.id,
      stepRunId: running.id,
      attemptId: attempt.id,
      producerActorId: running.actorId,
      status: outcome.status === "completed" ? "completed" : "failed",
      summary: outcome.summary,
      output: outcome.output ?? { summary: outcome.summary },
      artifacts: outcome.artifacts ?? [],
      ...(outcome.error ? { error: outcome.error } : {}),
      startedAt: attempt.startedAt,
      completedAt,
    };
    const completedAttempt: StepAttempt = {
      ...attempt,
      phase: outcome.status === "completed" ? "completed" : outcome.status === "blocked" ? "blocked" : "failed",
      producerActorId: running.actorId,
      ...(outcome.agentSessionId ? { agentSessionId: outcome.agentSessionId } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      completedAt,
    };
    const retry = outcome.status === "failed" && ordinal < step.maxAttempts && this.#withinAttemptBudget(state);
    const nextPhase = outcome.status === "completed" ? "completed" : outcome.status === "blocked" ? "blocked" : retry ? "pending" : "failed";
    const { activeAttemptId: _activeAttempt, ...runningWithoutActive } = running;
    const completedStep: StepRun = retry
      ? { ...runningWithoutActive, phase: "pending", message: `Retrying after: ${outcome.summary}`, updatedAt: completedAt }
      : { ...runningWithoutActive, phase: nextPhase, resultId: result.id, message: outcome.summary, updatedAt: completedAt };
    state.results.set(result.id, result);
    state.attempts.set(attempt.id, completedAttempt);
    state.stepRuns.set(running.id, completedStep);
    await this.#persist({ kind: "step-result", entity: result }, result.summary, `result:create:${result.id}`);
    await this.#persist({ kind: "step-attempt", entity: completedAttempt }, result.summary, `attempt:finish:${attempt.id}:${completedAttempt.phase}`);
    await this.#persist({ kind: "step-run", entity: completedStep }, completedStep.message, `step-finish:${completedStep.id}:${attempt.id}:${completedStep.phase}`);
  }

  async #createLease(state: RuntimeState, stepRun: StepRun, step: FlowStepDefinition, ordinal: number): Promise<PermissionLease | undefined> {
    const required = step.requiredCapabilities ?? [];
    const actorCapabilities = new Set(this.#port.actorCapabilities(stepRun.actorId));
    const ceiling = new Set(state.flow.permissionCeiling);
    const approved = new Set([...state.permissionRequests.values()]
      .filter((request) => request.stepRunId === stepRun.id && request.phase === "approved")
      .flatMap((request) => request.requestedCapabilities));
    const missing = required.filter((capability) => !ceiling.has(capability) || !actorCapabilities.has(capability) && !approved.has(capability));
    if (missing.length > 0) {
      const existing = [...state.permissionRequests.values()].find((request) => request.stepRunId === stepRun.id && request.phase === "open");
      if (!existing) {
        const now = this.#now();
        const request: PermissionRequest = {
          id: `permissionrequest_${ulid()}`,
          flowRunId: state.run.id,
          stepRunId: stepRun.id,
          actorId: stepRun.actorId,
          requestedCapabilities: missing,
          reason: `Step ${step.name} requires ${missing.join(", ")}`,
          phase: "open",
          createdAt: now,
          updatedAt: now,
        };
        state.permissionRequests.set(request.id, request);
        await this.#persist({ kind: "permission-request", entity: request }, request.reason, `permission-request:create:${request.id}`);
      }
      const blocked = this.#touch({ ...stepRun, phase: "blocked" as const, message: `Waiting for permission: ${missing.join(", ")}` });
      state.stepRuns.set(blocked.id, blocked);
      await this.#persist({ kind: "step-run", entity: blocked }, blocked.message, `permission-blocked:${blocked.id}:${ordinal}`);
      return undefined;
    }
    const budget = state.flow.budget ?? defaultBudget();
    const now = this.#clock.now();
    const lease: PermissionLease = {
      id: `lease_${ulid()}`,
      flowRunId: state.run.id,
      stepRunId: stepRun.id,
      actorId: stepRun.actorId,
      capabilities: [...new Set([...required, ...state.flow.permissionCeiling.filter((item) => actorCapabilities.has(item))])],
      workspaceScopes: [`run:${state.run.id}`],
      maxRuntimeMs: Math.min(step.timeoutMs, budget.maxRuntimeMs),
      maxAttempts: Math.min(step.maxAttempts, budget.maxTotalAttempts),
      ...(budget.maxCostUsd !== undefined ? { maxCostUsd: budget.maxCostUsd } : {}),
      expiresAt: new Date(now.getTime() + budget.maxRuntimeMs).toISOString(),
      status: "active",
    };
    state.leases.set(lease.id, lease);
    await this.#persist({ kind: "permission-lease", entity: lease }, `Lease granted to ${lease.actorId}`, `lease:create:${lease.id}`);
    return lease;
  }

  async #skipStep(state: RuntimeState, stepRun: StepRun, selected: StepRun[], reason: string): Promise<void> {
    const now = this.#now();
    const result: StepResult = {
      id: `stepresult_${ulid()}`,
      flowRunId: state.run.id,
      stepRunId: stepRun.id,
      attemptId: `no-attempt:${stepRun.id}`,
      producerActorId: "system:flow-engine",
      status: "skipped",
      summary: reason,
      output: {},
      artifacts: [],
      startedAt: now,
      completedAt: now,
    };
    const skipped: StepRun = { ...stepRun, phase: "skipped", selectedDependencyStepRunIds: selected.map((item) => item.id), resultId: result.id, message: reason, updatedAt: now };
    state.results.set(result.id, result);
    state.stepRuns.set(skipped.id, skipped);
    await this.#persist({ kind: "step-result", entity: result }, reason, `result:skip:${result.id}`);
    await this.#persist({ kind: "step-run", entity: skipped }, reason, `step-skip:${skipped.id}`);
  }

  async #refreshRun(state: RuntimeState, message: string): Promise<void> {
    const stepRuns = [...state.stepRuns.values()];
    const completed = stepRuns.filter((item) => item.phase === "completed").map((item) => item.stepId);
    const failed = stepRuns.filter((item) => item.phase === "failed").map((item) => item.stepId);
    const skipped = stepRuns.filter((item) => item.phase === "skipped").map((item) => item.stepId);
    const blocked = stepRuns.filter((item) => item.phase === "blocked").map((item) => item.stepId);
    const current = stepRuns.filter((item) => item.phase === "ready" || item.phase === "running").map((item) => item.stepId);
    let phase: FlowRun["phase"] = "running";
    if (stepRuns.length > 0 && stepRuns.every((item) => item.phase === "completed" || item.phase === "skipped")) phase = "completed";
    else if (stepRuns.length > 0 && stepRuns.every((item) => isStepTerminal(item.phase)) && failed.length > 0) phase = "failed";
    else if (current.length === 0 && state.active.size === 0 && blocked.length > 0) phase = "blocked";
    const effectiveMessage = phase === "completed" ? "Flow run completed" : phase === "failed" ? "Flow run failed" : phase === "blocked" ? "Flow run is waiting for human input or permission" : message;
    const next = this.#updateRun(state.run, {
      phase,
      currentStepIds: current,
      completedStepIds: completed,
      failedStepIds: failed,
      skippedStepIds: skipped,
      blockedStepIds: blocked,
      message: effectiveMessage,
    });
    if (sameRunState(state.run, next)) return;
    state.run = next;
    await this.#port.persistRun(next, effectiveMessage);
  }

  async #persist(change: CollaborationChange, message: string, idempotencyKey: string): Promise<void> {
    await this.#port.persistCollaboration(change, message, idempotencyKey);
  }

  #withinAttemptBudget(state: RuntimeState): boolean {
    const budget = state.flow.budget ?? defaultBudget();
    return (state.run.totalAttempts ?? 0) < budget.maxTotalAttempts && this.#clock.now().getTime() - Date.parse(state.run.createdAt) < budget.maxRuntimeMs;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #touch<T extends { updatedAt: string }>(item: T): T {
    return { ...item, updatedAt: this.#now() };
  }

  #updateRun(run: FlowRun, patch: Partial<FlowRun>): FlowRun {
    return { ...run, ...patch, updatedAt: this.#now() };
  }

  #findHumanTask(taskId: string): { state: RuntimeState; task: HumanTask } {
    for (const state of this.#states.values()) {
      const task = state.humanTasks.get(taskId);
      if (task) return { state, task };
    }
    throw new Error(`human task not found: ${taskId}`);
  }

  #findPermissionRequest(requestId: string): { state: RuntimeState; request: PermissionRequest } {
    for (const state of this.#states.values()) {
      const request = state.permissionRequests.get(requestId);
      if (request) return { state, request };
    }
    throw new Error(`permission request not found: ${requestId}`);
  }

  #schedule(flow: FlowDefinition): void {
    const existing = this.#timers.get(flow.id);
    if (existing) clearInterval(existing);
    this.#timers.delete(flow.id);
    if (flow.status !== "published" || flow.trigger.kind !== "schedule") return;
    const timer = setInterval(() => { void this.trigger(flow.id, "schedule"); }, flow.trigger.intervalMs);
    timer.unref();
    this.#timers.set(flow.id, timer);
  }
}

export function assembleStepPrompt(
  flow: FlowDefinition,
  run: FlowRun,
  step: FlowStepDefinition,
  stepRun: StepRun,
  dependencies: StepResult[],
  lease: PermissionLease,
): string {
  const dependencyPayload = dependencies.map((result) => ({
    stepRunId: result.stepRunId,
    producerActorId: result.producerActorId,
    status: result.status,
    summary: result.summary,
    output: result.output,
    artifacts: result.artifacts,
  }));
  return [
    step.prompt,
    "",
    "MYCEL COLLABORATION CONTEXT",
    `Flow: ${flow.name} (${flow.id} v${run.flowVersion})`,
    `Run: ${run.id}`,
    `Step: ${step.name} (${stepRun.id})`,
    `Permission lease: ${lease.id}`,
    `Capabilities: ${lease.capabilities.join(", ") || "none"}`,
    "Dependency results (JSON):",
    JSON.stringify(dependencyPayload, null, 2),
    "",
    "Return a concise summary plus any concrete output or file evidence needed by downstream actors.",
  ].join("\n");
}

function evaluateStep(state: RuntimeState, step: FlowStepDefinition): StepEvaluation {
  if (step.dependsOn.length === 0) {
    if (step.condition === "previous-failed") return { kind: "skip", selected: [], reason: "Condition previous-failed is false for a root step" };
    return { kind: "ready", selected: [] };
  }
  const dependencies = step.dependsOn.map((id) => requiredItem(state.stepRuns, stepRunId(state.run.id, id), "dependency step run"));
  const terminal = dependencies.filter((item) => isStepTerminal(item.phase));
  const successful = terminal.filter((item) => item.phase === "completed").sort(byCompletion(state));
  const mode = step.join?.mode ?? "all";
  let selected: StepRun[] | undefined;
  let impossible = false;
  if (mode === "all") {
    if (terminal.length === dependencies.length) selected = dependencies;
  } else if (mode === "any") {
    if (successful.length > 0) selected = [successful[0]!];
    else if (terminal.length === dependencies.length) { selected = terminal; impossible = true; }
  } else if (mode === "quorum") {
    const quorum = step.join?.quorum ?? dependencies.length;
    if (successful.length >= quorum) selected = successful.slice(0, quorum);
    else if (successful.length + (dependencies.length - terminal.length) < quorum) { selected = terminal; impossible = true; }
  } else if (terminal.length > 0) {
    selected = [...terminal].sort(byCompletion(state)).slice(0, 1);
  }
  if (!selected) return { kind: "waiting" };
  const hasFailure = selected.some((item) => item.phase === "failed" || item.phase === "cancelled");
  const allSucceeded = selected.length > 0 && selected.every((item) => item.phase === "completed");
  const conditionMet = step.condition === "always" || step.condition === "previous-succeeded" && allSucceeded || step.condition === "previous-failed" && hasFailure;
  if (!conditionMet || impossible && step.condition === "previous-succeeded") {
    return { kind: "skip", selected, reason: impossible ? `${mode} join cannot reach its success threshold` : `Condition ${step.condition} is false` };
  }
  return { kind: "ready", selected };
}

function dependencyResults(state: RuntimeState, stepRun: StepRun): StepResult[] {
  return stepRun.selectedDependencyStepRunIds.flatMap((id) => {
    const dependency = state.stepRuns.get(id);
    const result = dependency?.resultId ? state.results.get(dependency.resultId) : undefined;
    return result ? [result] : [];
  });
}

function attemptsFor(state: RuntimeState, stepRunIdValue: string): StepAttempt[] {
  return [...state.attempts.values()].filter((attempt) => attempt.stepRunId === stepRunIdValue).sort((left, right) => left.ordinal - right.ordinal);
}

function byCompletion(state: RuntimeState): (left: StepRun, right: StepRun) => number {
  return (left, right) => {
    const leftResult = left.resultId ? state.results.get(left.resultId) : undefined;
    const rightResult = right.resultId ? state.results.get(right.resultId) : undefined;
    return (leftResult?.completedAt ?? left.updatedAt).localeCompare(rightResult?.completedAt ?? right.updatedAt) || left.stepId.localeCompare(right.stepId);
  };
}

function normalizeFlow(flow: FlowDefinition): FlowDefinition {
  return {
    ...flow,
    maxConcurrency: flow.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    budget: flow.budget ?? defaultBudget(),
    steps: flow.steps.map((step) => ({ ...step, join: step.join ?? { mode: "all" }, requiredCapabilities: step.requiredCapabilities ?? [] })),
  };
}

function normalizeRun(run: FlowRun): FlowRun {
  return { ...run, skippedStepIds: run.skippedStepIds ?? [], blockedStepIds: run.blockedStepIds ?? [], totalAttempts: run.totalAttempts ?? 0 };
}

function defaultBudget(): FlowBudget {
  return { maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS, maxTotalAttempts: DEFAULT_MAX_TOTAL_ATTEMPTS };
}

function validateFlow(input: Pick<FlowDefinition, "steps" | "trigger" | "maxConcurrency" | "budget">): void {
  if (input.steps.length === 0) throw new Error("flow requires at least one step");
  if ((input.maxConcurrency ?? 0) < 1 || (input.maxConcurrency ?? 0) > 32) throw new Error("flow maxConcurrency must be between 1 and 32");
  if ((input.budget?.maxRuntimeMs ?? 0) < 1_000 || (input.budget?.maxTotalAttempts ?? 0) < 1) throw new Error("flow budget is invalid");
  const ids = new Set(input.steps.map((step) => step.id));
  if (ids.size !== input.steps.length) throw new Error("flow step IDs must be unique");
  for (const step of input.steps) {
    if (step.maxAttempts < 1 || step.maxAttempts > 10) throw new Error(`invalid maxAttempts for ${step.id}`);
    if (step.timeoutMs < 1_000) throw new Error(`invalid timeout for ${step.id}`);
    for (const dependency of step.dependsOn) if (!ids.has(dependency)) throw new Error(`missing dependency ${dependency}`);
    if (step.join?.mode === "quorum") {
      const quorum = step.join.quorum ?? 0;
      if (step.dependsOn.length < 2 || quorum < 1 || quorum > step.dependsOn.length) throw new Error(`invalid quorum for ${step.id}`);
    }
  }
  if (hasCycle(input.steps)) throw new Error("flow graph must be acyclic");
  if (input.trigger.kind === "schedule" && input.trigger.intervalMs < 10_000) throw new Error("schedule interval must be at least 10 seconds");
}

function hasCycle(steps: FlowStepDefinition[]): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return steps.some((step) => visit(step.id));
}

function requiredFlow(flows: Map<string, FlowDefinition>, id: string): FlowDefinition {
  return requiredItem(flows, id, "flow");
}

function requiredState(states: Map<string, RuntimeState>, id: string): RuntimeState {
  return requiredItem(states, id, "flow run");
}

function requiredStep(flow: FlowDefinition, id: string): FlowStepDefinition {
  const step = flow.steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`flow step not found: ${id}`);
  return step;
}

function requiredItem<T>(items: Map<string, T>, id: string, label: string): T {
  const item = items.get(id);
  if (!item) throw new Error(`${label} not found: ${id}`);
  return item;
}

function indexBy<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function stepRunId(runId: string, stepId: string): string {
  return `steprun:${runId}:${stepId}`;
}

function sameRunState(left: FlowRun, right: FlowRun): boolean {
  return left.phase === right.phase
    && left.message === right.message
    && left.totalAttempts === right.totalAttempts
    && arraysEqual(left.currentStepIds, right.currentStepIds)
    && arraysEqual(left.completedStepIds, right.completedStepIds)
    && arraysEqual(left.failedStepIds, right.failedStepIds)
    && arraysEqual(left.skippedStepIds ?? [], right.skippedStepIds ?? [])
    && arraysEqual(left.blockedStepIds ?? [], right.blockedStepIds ?? []);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isStepTerminal(phase: StepRun["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "skipped" || phase === "cancelled";
}

function isRunTerminal(phase: FlowRun["phase"]): boolean {
  return phase === "completed" || phase === "failed" || phase === "canceled";
}

async function withTimeout(result: Promise<AgentStepExecutionResult>, timeoutMs: number): Promise<AgentStepExecutionResult> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<AgentStepExecutionResult>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "failed", summary: `Step timed out after ${timeoutMs}ms`, error: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
