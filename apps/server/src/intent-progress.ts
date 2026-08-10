export type IntentProgressPhase = "accepted" | "preparing-workspace" | "invoking-steward" | "inspecting-resources" | "validating-result" | "composing-response" | "completed" | "failed";

export interface IntentProgressView {
  requestId: string;
  conversationId: string;
  workspaceId: string;
  phase: IntentProgressPhase;
  label: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  errorCode?: string;
}

const order: IntentProgressPhase[] = ["accepted", "preparing-workspace", "invoking-steward", "inspecting-resources", "validating-result", "composing-response", "completed", "failed"];
const labels: Record<IntentProgressPhase, string> = {
  accepted: "已收到，正在高速运转中",
  "preparing-workspace": "正在准备 Workspace 上下文",
  "invoking-steward": "Steward 正在理解并处理任务",
  "inspecting-resources": "正在检查 Workspace 资源",
  "validating-result": "正在校验结果",
  "composing-response": "正在整理回复",
  completed: "处理完成",
  failed: "这次处理没有完成",
};

export class IntentProgressHub {
  readonly #items = new Map<string, IntentProgressView>();

  start(input: { requestId: string; conversationId: string; workspaceId: string }): IntentProgressView {
    const existing = this.#items.get(input.requestId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const item: IntentProgressView = { ...input, phase: "accepted", label: labels.accepted, startedAt: now, updatedAt: now };
    this.#items.set(input.requestId, item);
    return item;
  }

  update(requestId: string, phase: IntentProgressPhase, errorCode?: string): IntentProgressView | undefined {
    const previous = this.#items.get(requestId);
    if (!previous || previous.phase === "completed" || previous.phase === "failed") return previous;
    if (phase !== "failed" && order.indexOf(phase) < order.indexOf(previous.phase)) return previous;
    const now = new Date().toISOString();
    const item: IntentProgressView = { ...previous, phase, label: labels[phase], updatedAt: now, ...(["completed", "failed"].includes(phase) ? { completedAt: now } : {}), ...(errorCode ? { errorCode } : {}) };
    this.#items.set(requestId, item);
    return item;
  }

  list(conversationId?: string): IntentProgressView[] {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, item] of this.#items) if (item.completedAt && Date.parse(item.completedAt) < cutoff) this.#items.delete(id);
    return [...this.#items.values()].filter((item) => !conversationId || item.conversationId === conversationId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}
