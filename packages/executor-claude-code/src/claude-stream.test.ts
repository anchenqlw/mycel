import { describe, expect, it } from "vitest";
import { parseClaudeStream } from "./claude-stream.js";

describe("parseClaudeStream", () => {
  it("extracts tool progress and the terminal result", () => {
    const output = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "session-1", result: "Fixed", total_cost_usd: 0.04, duration_ms: 200, is_error: false }),
    ].join("\n");
    expect(parseClaudeStream(output)).toEqual({
      sessionId: "session-1",
      resultText: "Fixed",
      costUsd: 0.04,
      durationMs: 200,
      isError: false,
      progress: [{ stage: "tool", message: "Edit", rawType: "tool_use" }],
    });
  });
});
