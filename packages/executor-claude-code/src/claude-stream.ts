export interface ClaudeStreamSummary {
  sessionId?: string;
  resultText: string;
  costUsd?: number;
  durationMs?: number;
  isError: boolean;
  progress: Array<{ stage: string; message: string; rawType: string }>;
}

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
  message?: { content?: Array<{ type?: string; name?: string; text?: string }> };
}

export function parseClaudeStream(output: string): ClaudeStreamSummary {
  const summary: ClaudeStreamSummary = { resultText: "", isError: false, progress: [] };
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      continue;
    }
    if (event.session_id) summary.sessionId = event.session_id;
    if (event.type === "assistant") {
      for (const content of event.message?.content ?? []) {
        if (content.type === "tool_use" && content.name) {
          summary.progress.push({ stage: "tool", message: content.name, rawType: "tool_use" });
        } else if (content.type === "text" && content.text) {
          summary.progress.push({ stage: "reasoning", message: content.text.slice(0, 240), rawType: "text" });
        }
      }
    }
    if (event.type === "result") {
      summary.resultText = event.result ?? "";
      summary.isError = event.is_error ?? event.subtype !== "success";
      if (event.total_cost_usd !== undefined) summary.costUsd = event.total_cost_usd;
      if (event.duration_ms !== undefined) summary.durationMs = event.duration_ms;
    }
  }
  return summary;
}
