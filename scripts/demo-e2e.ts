import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runChecked } from "@mycel/executor-claude-code";
import { buildServer } from "../apps/server/src/server.js";
import { loadConfig } from "../apps/server/src/config.js";
import { createRuntime } from "../apps/server/src/runtime.js";
import { resetDemoData } from "./reset-demo.js";

const projectRoot = resolve(import.meta.dirname, "..");
await resetDemoData({
  dataDir: resolve(projectRoot, ".local/mycel"),
  repositoryPath: resolve(projectRoot, ".local/demo-repo"),
}, resolve(projectRoot, ".local"));
const config = loadConfig({
  ...process.env,
  MYCEL_TARGET_REPO: ".local/demo-repo",
  MYCEL_DATA_DIR: ".local/mycel",
  DINGTALK_CLIENT_ID: undefined,
  DINGTALK_CLIENT_SECRET: undefined,
  DINGTALK_CARD_TEMPLATE_ID: undefined,
  DINGTALK_ALLOWED_USER_IDS: undefined,
  DINGTALK_ROBOT_CODE: undefined,
}, projectRoot);
const runtime = await createRuntime(config);
const server = await buildServer(runtime);

try {
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("failed to resolve E2E server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const submitted = await post<{
    kind: "changeset";
    changeSet: { id: string; status: string };
  }>(baseUrl, "/api/intents", {
    text: "创建一个独立 Task 修复 CSV 导出中的 UTF-8 BOM，并确保现有测试通过。source 使用当前 web 对话，Owner 是 human:owner，候选 Worker 是 agent:codex，Workspace 是 repository。生成 ChangeSet 等我批准，不要直接执行。",
  });
  if (submitted.kind !== "changeset") throw new Error(`expected a ChangeSet, received ${submitted.kind}`);
  if (submitted.changeSet.status !== "awaiting-approval") throw new Error(`expected a human approval gate, received ${submitted.changeSet.status}`);
  await post(baseUrl, `/api/change-sets/${encodeURIComponent(submitted.changeSet.id)}/approve`, { actorId: "human:owner" });
  const applied = await post<{ status: string }>(baseUrl, `/api/change-sets/${encodeURIComponent(submitted.changeSet.id)}/apply`, {});
  if (applied.status !== "applied") throw new Error(`ChangeSet did not apply: ${applied.status}`);
  const afterApply = await get<Projection>(baseUrl, "/api/state");
  const task = Object.values(afterApply.tasks)[0];
  if (!task) throw new Error("ChangeSet did not create a Task");
  await post(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}/start`, {
    workerId: "agent:codex", workspaceId: "repository", instruction: task.description,
    mode: "execute", actorId: "human:owner", expectedVersion: task.version,
  });

  const projection = await waitForTerminalTask(baseUrl, config.executor.timeoutMs + 60_000);
  const finishedTask = projection.tasks[task.id];
  if (!finishedTask || finishedTask.status !== "awaiting-acceptance") throw new Error(`Task did not reach acceptance: ${finishedTask?.status ?? "missing"}`);
  await runChecked("npm", ["test"], { cwd: config.repositoryPath });
  const exporter = readFileSync(resolve(config.repositoryPath, "src/export.js"), "utf8");
  if (!/\\u[fF][eE][fF]{2}/.test(exporter) && !exporter.includes("\uFEFF")) {
    throw new Error("Worker session completed without adding the UTF-8 BOM");
  }
  await post(baseUrl, `/api/tasks/${encodeURIComponent(task.id)}/accept`, { actorId: "human:owner", expectedVersion: finishedTask.version });
  const accepted = await get<Projection>(baseUrl, "/api/state");
  const completedTask = accepted.tasks[task.id];
  if (completedTask?.status !== "completed") throw new Error("Task was not completed after acceptance");
  const session = Object.values(accepted.workerSessions).find((item) => item.taskId === task.id);
  console.log(JSON.stringify({
    changeSetId: submitted.changeSet.id,
    taskId: task.id,
    workerSessionId: session?.id,
    evidenceCount: completedTask.evidenceIds.length,
    ledgerEvents: runtime.application.readLedger().length,
    status: completedTask.status,
  }, null, 2));
} finally {
  runtime.stop();
  await server.close();
}

interface Projection {
  graph: { nodes: Array<{ id: string; status?: string }> };
  runs: Record<string, { id: string; workId: string; phase: string }>;
  evidence: Record<string, unknown>;
  tasks: Record<string, { id: string; version: number; title: string; description: string; status: string; evidenceIds: string[] }>;
  workerSessions: Record<string, { id: string; taskId?: string; phase: string }>;
}

async function waitForTerminalTask(baseUrl: string, timeoutMs: number): Promise<Projection> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const projection = await get<Projection>(baseUrl, "/api/state");
    const task = Object.values(projection.tasks)[0];
    if (task && ["awaiting-acceptance", "failed", "canceled"].includes(task.status)) return projection;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`demo Task E2E timed out after ${timeoutMs}ms`);
}

async function get<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  return responseJson<T>(response);
}

async function post<T = unknown>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return responseJson<T>(response);
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
  return body;
}
