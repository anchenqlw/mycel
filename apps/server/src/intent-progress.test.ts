import { describe, expect, it } from "vitest";
import { IntentProgressHub } from "./intent-progress.js";

describe("IntentProgressHub", () => {
  it("keeps phases monotonic and ignores late events after completion", () => {
    const hub = new IntentProgressHub();
    hub.start({ requestId: "request-1", conversationId: "web:owner", workspaceId: "repository" });
    hub.update("request-1", "invoking-steward");
    hub.update("request-1", "preparing-workspace");
    expect(hub.list()[0]?.phase).toBe("invoking-steward");
    hub.update("request-1", "completed");
    hub.update("request-1", "inspecting-resources");
    expect(hub.list()[0]).toMatchObject({ phase: "completed", label: "处理完成" });
  });

  it("isolates conversations and terminates failures", () => {
    const hub = new IntentProgressHub();
    hub.start({ requestId: "one", conversationId: "conversation:one", workspaceId: "workspace:one" });
    hub.start({ requestId: "two", conversationId: "conversation:two", workspaceId: "workspace:two" });
    hub.update("two", "failed", "intent-failed");
    expect(hub.list("conversation:one").map((item) => item.requestId)).toEqual(["one"]);
    expect(hub.list("conversation:two")[0]).toMatchObject({ phase: "failed", errorCode: "intent-failed" });
  });
});
