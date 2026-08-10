import type { AppProjection, MutationView, RunView } from "@mycel/application";
import type { ProductionProposal } from "@mycel/domain";

export interface CardModel {
  state: string;
  params: Record<string, string>;
}

export function mutationCardModel(mutation: MutationView): CardModel {
  const pending = mutation.pendingOperationIds.length;
  const state = pending > 0 ? "awaiting_approval" : mutation.status;
  const risk = mutation.aggregateRisk.toUpperCase();
  return {
    state,
    params: {
      title: pending > 0 ? "Mycel · 等待你的批准" : "Mycel · 任务已批准",
      status: pending > 0 ? `🔴 ${risk} · 待批准` : `🟢 ${risk} · 已批准`,
      summary: mutation.diff.intentSummary,
      details: operationDetails(mutation),
      primaryLabel: pending > 0 ? "批准并执行" : "查看执行状态",
      primaryAction: pending > 0 ? "approve" : "noop",
      secondaryLabel: pending > 0 ? "拒绝" : "",
      secondaryAction: pending > 0 ? "reject" : "noop",
      aggregateId: mutation.id,
      mutationId: mutation.id,
      workId: workIdFromMutation(mutation) ?? "",
      runId: "",
      evidence: "",
    },
  };
}

export function proposalCardModel(proposal: ProductionProposal): CardModel {
  const ready = proposal.status === "ready";
  const plan = proposal.plan;
  const trigger = plan.trigger.kind === "schedule" ? `${plan.trigger.timeOfDay} ${plan.trigger.timezone}` : plan.trigger.kind;
  return {
    state: proposal.status,
    params: {
      title: ready ? "Mycel · 生产图等待批准" : `Mycel · 生产图${proposal.status === "approved" ? "已部署" : "已更新"}`,
      status: ready ? "🟡 ProductionPlan · 待批准" : proposal.status === "approved" ? "🟢 已部署" : `⚪ ${proposal.status}`,
      summary: `${plan.title}\n${plan.summary}`,
      details: `${trigger} · ${plan.actors.length} Actors · ${plan.steps.length} Steps\n权限上限：${plan.permissionCeiling.join(", ") || "none"}\n${plan.steps.map((step) => `• ${step.name}`).join("\n")}`,
      primaryLabel: ready ? "批准并部署" : "查看状态",
      primaryAction: ready ? "approve_proposal" : "noop",
      secondaryLabel: ready ? "拒绝" : "",
      secondaryAction: ready ? "reject_proposal" : "noop",
      aggregateId: proposal.id,
      mutationId: "",
      workId: proposal.compiledFlowId,
      runId: "",
      evidence: "",
    },
  };
}

export function runCardModel(run: RunView, projection: AppProjection): CardModel {
  const mutation = projection.mutations[run.mutationId];
  if (!mutation) throw new Error(`mutation not found for run ${run.id}`);
  const workId = run.workId;
  const work = projection.graph.nodes.find((node) => node.id === workId && node.type === "work");
  const evidence = Object.values(projection.evidence).filter((item) => item.runId === run.id);
  const evidenceText = evidence.length === 0
    ? "尚未生成证据"
    : evidence.map((item) => `${item.passed === false ? "❌" : "✅"} ${item.kind} · ${item.sha256.slice(0, 10)}`).join("\n");
  const awaitingAcceptance = run.phase === "succeeded" && work?.type === "work" && work.status === "awaiting_acceptance";
  const completed = work?.type === "work" && work.status === "completed";
  const state = completed ? "completed" : awaitingAcceptance ? "awaiting_acceptance" : run.phase;
  const status = completed
    ? "✅ 已验收完成"
    : awaitingAcceptance
      ? "🟡 执行成功 · 待验收"
      : run.phase === "failed"
        ? "❌ 执行失败"
        : run.phase === "canceled"
          ? "⚪ 已取消"
          : `🔵 ${run.stage}`;
  return {
    state,
    params: {
      title: "Mycel · Claude Code 执行单",
      status,
      summary: mutation.diff.intentSummary,
      details: run.message,
      primaryLabel: awaitingAcceptance ? "验收通过" : run.phase === "started" || run.phase === "progress" ? "取消执行" : "查看详情",
      primaryAction: awaitingAcceptance ? "accept" : run.phase === "started" || run.phase === "progress" ? "cancel" : "noop",
      secondaryLabel: awaitingAcceptance ? "退回修改" : "",
      secondaryAction: awaitingAcceptance ? "reject_acceptance" : "noop",
      aggregateId: awaitingAcceptance ? workId : run.id,
      mutationId: mutation.id,
      workId,
      runId: run.id,
      evidence: evidenceText,
    },
  };
}

function operationDetails(mutation: MutationView): string {
  return mutation.diff.operations.map((operation) => {
    const risk = mutation.operationRisks[operation.operationId]?.toUpperCase() ?? "UNKNOWN";
    return `${risk === "RED" ? "🔴" : risk === "YELLOW" ? "🟡" : "🟢"} ${operation.explanation}`;
  }).join("\n");
}

function workIdFromMutation(mutation: MutationView): string | undefined {
  const operation = mutation.diff.operations.find((item) => item.op === "add_node" && item.node.type === "work");
  return operation?.op === "add_node" ? operation.node.id : undefined;
}
