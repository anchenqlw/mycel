import { sanitizeForPresentation } from "@mycel/domain";
import { useState } from "react";
import { SelectField } from "./SelectField.js";

export function FailedChangeSetRecoveryAction({ changeSetId, title, status, onAskSteward }: { changeSetId: string; title: string; status: string; onAskSteward: (text: string) => void }) {
  const request = `ChangeSet ${title}（${changeSetId}）没有完成。请根据当前 Graph 重新检查目标和影响，生成一个新的 ChangeSet；不要重放旧操作。`;
  const explanation = status === "partially-applied"
    ? "已成功应用的变更会保留；未完成的旧操作不会自动重放。让 Steward 按当前 Graph 重新生成一组可审核的变更。"
    : "现有 Graph 保持不变。让 Steward 按当前状态重新生成一组可审核的变更。";
  return <div className="recovery-inline"><b>这组变更没有完成</b><p>{explanation}</p><button onClick={() => onAskSteward(request)}>让 Steward 重新生成 →</button></div>;
}

export function isRecoverableChangeSetStatus(status: string): boolean {
  return status === "failed" || status === "partially-applied";
}

export function eligibleReplacementWorkers<T extends { status: string; adapterKind: string }>(agents: T[]): T[] {
  return agents.filter((agent) => agent.status === "online" && (agent.adapterKind === "claude-code" || agent.adapterKind === "codex"));
}

export function HistoryEventPayload({ payload }: { payload: unknown }) {
  return <pre>{JSON.stringify(sanitizeForPresentation(payload), null, 2)}</pre>;
}

export function humanTaskPresentationTitle(input: {
  task: { stepRunId: string };
  stepRuns: Record<string, { flowRunId: string; stepId: string; message?: string }>;
  flowRuns: Record<string, { flowId: string }>;
  flows: Record<string, { steps: Array<{ id: string; name: string }> }>;
}): string {
  const stepRun = input.stepRuns[input.task.stepRunId];
  const flowRun = stepRun ? input.flowRuns[stepRun.flowRunId] : undefined;
  const step = flowRun && stepRun ? input.flows[flowRun.flowId]?.steps.find((candidate) => candidate.id === stepRun.stepId) : undefined;
  return step?.name ?? "需要人工处理";
}

function safePresentationMessage(value: string | undefined): string | undefined {
  const sanitized = sanitizeForPresentation(value);
  return typeof sanitized === "string" && sanitized.trim() ? sanitized : undefined;
}

export function flowRunPresentationMessage(message: string | undefined, fallback: string): string {
  const safe = safePresentationMessage(message);
  if (safe === "Worker cannot access the selected Workspace") return "Worker 无法访问这个 Flow 的 Workspace。请查看失败步骤后重试或替换 Worker。";
  if (safe === "Worker is not connected to a local execution adapter") return "Worker 当前没有可用的本地执行适配器。请查看失败步骤后重试或替换 Worker。";
  return safe ?? fallback;
}

export function taskPresentationMessage(task: { description: string; resultSummary?: string }): string {
  const description = flowRunPresentationMessage(task.description, "等待任务状态更新");
  return flowRunPresentationMessage(task.resultSummary, description);
}

export function stepRunPresentationMessage(input: { phase: string; message: string | undefined; stepKind: string | undefined; actorName: string }): string {
  if (input.phase === "blocked" && input.stepKind === "human") return `等待 ${input.actorName} 处理`;
  const safe = safePresentationMessage(input.message);
  if (input.phase === "failed" && input.stepKind === "agent" && safe === "Worker cannot access the selected Workspace") {
    return "这个 Worker 无法访问该 Flow 的 Workspace。请确认 Workspace 后重试，或选择另一个可用 Worker。";
  }
  if (input.phase === "failed" && input.stepKind === "agent" && safe === "Worker is not connected to a local execution adapter") {
    return "这个 Worker 当前没有可用的本地执行适配器。你可以重试，或选择一个已连接的本地 Worker 代替。";
  }
  return safe ?? "等待调度";
}

export function WorkerStepRecoveryActions({ agents, currentActorId, onRetry, onReplace }: {
  agents: Array<{ id: string; name: string; status: string; adapterKind: string }>;
  currentActorId: string;
  onRetry: () => void;
  onReplace: (actorId: string) => void;
}) {
  const candidates = eligibleReplacementWorkers(agents);
  const [choice, setChoice] = useState(currentActorId);
  const replacement = candidates.some((agent) => agent.id === choice) ? choice : candidates[0]?.id ?? "";
  return <div className="step-actions"><button onClick={onRetry}>重试 Worker</button><SelectField ariaLabel="选择替换 Worker（本地执行适配器）" value={replacement} onChange={setChoice} options={candidates.map((agent) => ({ value: agent.id, label: agent.name }))}/><button disabled={!replacement} onClick={() => onReplace(replacement)}>替换 Worker</button><small>仅显示已连接到本地执行适配器的 Worker</small></div>;
}

export function HumanTaskOpenActions({ humans, value, onChange, onClaim, onReassign }: {
  humans: Array<{ id: string; name?: string }>;
  value: string;
  onChange: (value: string) => void;
  onClaim: () => void;
  onReassign: () => void;
}) {
  return <div className="human-task-actions"><button onClick={onClaim}>领取任务</button><div className="human-task-reassign"><SelectField ariaLabel="选择新的处理人" value={value} onChange={onChange} options={humans.map((human) => ({ value: human.id, label: human.name ?? human.id }))}/><button onClick={onReassign}>重新指派</button></div></div>;
}

export function UnsupportedFileNotice({ relativePath, error, onOpen }: { relativePath: string; error: string; onOpen: () => void }) {
  return <div className="unsupported"><b>无法在工作台中预览</b><strong>{safeRelativeFileLabel(relativePath)}</strong><p>{error}</p><button onClick={onOpen}>用系统默认应用打开</button></div>;
}

export function safeRelativeFileLabel(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? "所选文件";
}
