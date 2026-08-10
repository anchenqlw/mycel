import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LocalFlowEngine } from "@mycel/flow-engine";
import { createPublicDemoApplication, PresentationFlowPort, seedPublicDemo } from "./public-demo-fixture.js";
import { resetDemoData } from "./reset-demo.js";
import { WorkspaceFilesService } from "@mycel/workspace-files";

const execFileAsync = promisify(execFile);
const projectRoot = join(import.meta.dirname, "..");

it("creates presentation coverage without machine or provider identity", async () => {
  const now = "2026-01-15T09:00:00.000Z";
  const root = await mkdtemp(join(tmpdir(), "mycel-public-fixture-"));
  const application = await createPublicDemoApplication(join(root, "ledger.sqlite"));
  await seedPublicDemo(application, now);
  const state = application.getProjection();
  expect(Object.keys(state.workers).sort()).toEqual(["worker:adopted:researcher", "worker:native:release-steward"]);
  expect(Object.values(state.workers).map((item) => item.source).sort()).toEqual(["adopted", "native"]);
  expect(Object.keys(state.workerSpecs).sort()).toEqual([
    "worker-spec:worker:adopted:researcher:v1",
    "worker-spec:worker:native:release-steward:v1",
  ]);
  const activeActors = state.graph.nodes.filter((node) => node.type === "actor" && !node.archivedAt);
  expect(activeActors.map((node) => node.id).sort()).toEqual([
    "human:owner",
    "worker:adopted:researcher",
    "worker:native:release-steward",
  ]);
  expect(activeActors.find((node) => node.id === "worker:adopted:researcher")).toMatchObject({
    runtime: "codex",
    adapterKind: "codex",
    source: "adopted",
  });
  const capabilities = state.graph.nodes.filter((node) => node.type === "capability" && !node.archivedAt);
  expect(capabilities.map((node) => node.id)).toEqual(["cap:repo-read"]);

  const flow = state.flows["flow:public-release-review"];
  expect(flow).toMatchObject({
    workspaceId: "repository",
    status: "published",
    trigger: { kind: "manual" },
    permissionCeiling: ["repository-read"],
    maxConcurrency: 4,
    budget: { maxRuntimeMs: 86_400_000, maxTotalAttempts: 8, maxCostUsd: 0 },
  });
  expect(flow?.steps.map((step) => ({ id: step.id, kind: step.kind, dependsOn: step.dependsOn, timeoutMs: step.timeoutMs, maxAttempts: step.maxAttempts }))).toEqual([
    { id: "inspect", kind: "agent", dependsOn: [], timeoutMs: 30_000, maxAttempts: 1 },
    { id: "summarize", kind: "agent", dependsOn: [], timeoutMs: 30_000, maxAttempts: 1 },
    { id: "approve", kind: "human", dependsOn: ["inspect", "summarize"], timeoutMs: 30_000, maxAttempts: 1 },
    { id: "publish", kind: "agent", dependsOn: ["approve"], timeoutMs: 30_000, maxAttempts: 1 },
  ]);
  expect(Object.values(state.flowRuns).filter((run) => run.phase === "completed")).toHaveLength(1);
  expect(Object.values(state.flowRuns).filter((run) => run.phase === "blocked")).toHaveLength(1);
  expect(Object.values(state.workerSessions)).toEqual(expect.arrayContaining([
    expect.objectContaining({ workerId: "worker:adopted:researcher", phase: "completed" }),
    expect.objectContaining({ workerId: "worker:native:release-steward", phase: "failed" }),
  ]));
  expect(Object.values(state.workerSessions).some((session) => session.summary.length >= 240)).toBe(true);
  expect(state.stewardResponses.some((response) => response.kind === "answer")).toBe(true);
  expect(state.stewardResponses.some((response) => response.kind === "clarification")).toBe(true);
  expect(Object.values(state.changeSets).some((changeSet) => changeSet.status === "awaiting-approval")).toBe(true);
  expect(state.messages.map((message) => message.id)).toEqual(["fixture:question", "fixture:clarification", "fixture:changeset"]);
  expect(state.messages.map((message) => message.text).join("\n")).not.toContain("fixture:");
  expect(state.messages.every((message) => message.text.trim().split(/\s+/).length > 2)).toBe(true);
  expect(state.graph.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "artifact:public-release-evidence", type: "artifact", kind: "evidence" }),
    expect.objectContaining({ id: "cap:repo-read", type: "capability", kind: "repository-read" }),
  ]));
  expect(state.graph.edges).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "produces", from: "work:flow:flow:public-release-review", to: "artifact:public-release-evidence" }),
    expect.objectContaining({ type: "authorization", from: "worker:adopted:researcher", to: "cap:repo-read" }),
    expect.objectContaining({ type: "authorization", from: "worker:native:release-steward", to: "cap:repo-read" }),
  ]));
  const timestamps = collectTimestampValues(state);
  expect([...new Set(timestamps)].sort()).toEqual([now, "2026-01-16T09:00:00.000Z"]);
  const serialized = JSON.stringify(state);
  expect(serialized).not.toMatch(/\/Users\/|\/home\/|github\.com|dingtalk|feishu|clientSecret|token|"argv":\["npm","test"\]|agent:codex|cap:claude-code|cap:codex/i);
});

it("continues a persisted public approval run after a realistic human review delay", async () => {
  const fixtureTime = "2026-08-08T09:00:00.000Z";
  const root = await mkdtemp(join(tmpdir(), "mycel-public-flow-resume-"));
  const application = await createPublicDemoApplication(join(root, "ledger.sqlite"));
  await seedPublicDemo(application, fixtureTime);
  const state = application.getProjection();
  const blockedRun = Object.values(state.flowRuns).find((run) => run.phase === "blocked");
  expect(blockedRun).toBeDefined();

  const resumed = new LocalFlowEngine(new PresentationFlowPort(application), {
    now: () => new Date("2026-08-08T09:05:00.000Z"),
  });
  resumed.restore(Object.values(state.flows), {
    runs: Object.values(state.flowRuns),
    stepRuns: Object.values(state.stepRuns),
    stepAttempts: Object.values(state.stepAttempts),
    stepResults: Object.values(state.stepResults),
    humanTasks: Object.values(state.humanTasks),
    permissionLeases: Object.values(state.permissionLeases),
    permissionRequests: Object.values(state.permissionRequests),
  });
  await resumed.waitForIdle();
  const approval = resumed.details(blockedRun!.id).humanTasks.find((task) => task.phase === "open");
  expect(approval).toBeDefined();
  await resumed.claimHumanTask(approval!.id, "human:owner", "public-fixture:delayed:claim");
  await resumed.completeHumanTask(approval!.id, "human:owner", { summary: "Demo Owner approved the release review." }, "public-fixture:delayed:complete");
  await resumed.waitForIdle();

  const details = resumed.details(blockedRun!.id);
  expect(details.runs[0]?.phase).toBe("completed");
  expect(details.stepRuns.find((stepRun) => stepRun.stepId === "publish")).toMatchObject({ phase: "completed" });
  resumed.stop();
});

it("isolates concurrent fixture clocks without changing global Date behavior", async () => {
  const firstTime = "2026-01-15T09:00:00.000Z";
  const secondTime = "2027-04-20T14:30:00.000Z";
  const NativeDate = globalThis.Date;
  const functionDateBefore = Date();
  const multiArgumentBefore = new Date(2020, 5, 15, 12, 34, 56, 789).getTime();
  const firstRoot = await mkdtemp(join(tmpdir(), "mycel-public-fixture-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "mycel-public-fixture-b-"));
  const firstApplication = await createPublicDemoApplication(join(firstRoot, "ledger.sqlite"));
  const secondApplication = await createPublicDemoApplication(join(secondRoot, "ledger.sqlite"));

  await Promise.all([
    seedPublicDemo(firstApplication, firstTime),
    seedPublicDemo(secondApplication, secondTime),
  ]);
  const dateIdentityAfter = globalThis.Date;
  const functionDateAfter = Date();
  const multiArgumentAfter = new Date(2020, 5, 15, 12, 34, 56, 789).getTime();

  const firstTimestamps = [...new Set(collectTimestampValues(firstApplication.getProjection()))].sort();
  const secondTimestamps = [...new Set(collectTimestampValues(secondApplication.getProjection()))].sort();
  expect({
    firstTimestamps,
    secondTimestamps,
    dateIdentityUnchanged: dateIdentityAfter === NativeDate,
    functionDateWorks: typeof functionDateAfter === "string" && functionDateBefore.length > 0 && functionDateAfter.length > 0,
    multiArgumentUnchanged: multiArgumentAfter === multiArgumentBefore,
  }).toEqual({
    firstTimestamps: [firstTime, "2026-01-16T09:00:00.000Z"],
    secondTimestamps: [secondTime, "2027-04-21T14:30:00.000Z"],
    dateIdentityUnchanged: true,
    functionDateWorks: true,
    multiArgumentUnchanged: true,
  });
});

it("rejects a reset target outside the supplied safe root", async () => {
  const root = await mkdtemp(join(tmpdir(), "mycel-public-reset-"));
  const outside = await mkdtemp(join(tmpdir(), "mycel-public-outside-"));

  await expect(resetDemoData({
    dataDir: join(root, "runtime"),
    repositoryPath: join(outside, "repository"),
  }, root)).rejects.toThrow("refusing to reset an unsafe target");
});

it("rejects an intermediate symlink escape without altering outside data", async () => {
  const root = await mkdtemp(join(tmpdir(), "mycel-public-reset-"));
  const outside = await mkdtemp(join(tmpdir(), "mycel-public-outside-"));
  const outsideRepository = join(outside, "repository");
  const sentinelPath = join(outsideRepository, "sentinel.txt");
  await mkdir(outsideRepository);
  await writeFile(sentinelPath, "outside sentinel", "utf8");
  await symlink(outside, join(root, "escape"));

  const outcome = await resetDemoData({
    dataDir: join(root, "runtime"),
    repositoryPath: join(root, "escape/repository"),
  }, root).then(
    () => ({ rejected: false, message: "resolved" }),
    (error: unknown) => ({ rejected: true, message: error instanceof Error ? error.message : String(error) }),
  );
  const sentinel = await readFile(sentinelPath, "utf8").catch(() => "missing");

  expect({ outcome, sentinel }).toEqual({
    outcome: { rejected: true, message: expect.stringContaining("refusing to reset an unsafe target") },
    sentinel: "outside sentinel",
  });
});

it("resets the public demo with the Git fixture and without printing an absolute path", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/reset-public-demo.ts"],
    { cwd: projectRoot },
  );

  expect(stdout.trim().split("\n")).toEqual([
    "Public demo repository ready",
    "Public demo runtime ready",
  ]);
  expect(stdout).not.toContain(projectRoot);
  await expect(access(join(projectRoot, ".local/public-demo/repository/.git"))).resolves.toBeUndefined();
  await expect(readFile(join(projectRoot, ".local/public-demo/repository/src/export.js"), "utf8")).resolves.toContain("exportCsv");
  await expect(access(join(projectRoot, ".local/public-demo/runtime/ledger.sqlite"))).resolves.toBeUndefined();
  const repositoryPath = join(projectRoot, ".local/public-demo/repository");
  const dataDir = join(projectRoot, ".local/public-demo/runtime");
  await expect(readFile(join(repositoryPath, "release-review.demoasset"), "utf8")).resolves.toContain("fictional public demo");
  const files = new WorkspaceFilesService({ repositoryPath, dataDir });
  await expect(files.registry.get("repository")).resolves.toMatchObject({ name: "Demo Workspace" });
  const listed = await files.list("repository");
  expect(listed).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "release-review.demoasset", path: "release-review.demoasset", kind: "file" }),
  ]));
  await expect(files.preview("repository", "release-review.demoasset")).rejects.toThrow("not supported");
});

function collectTimestampValues(value: unknown, key = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectTimestampValues(item, key));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([childKey, childValue]) => collectTimestampValues(childValue, childKey));
  }
  return typeof value === "string" && /(At|expiresAt)$/.test(key) ? [value] : [];
}
