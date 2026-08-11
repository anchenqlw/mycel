import { describe, expect, it } from "vitest";
import { emptyGraph } from "@mycel/domain";
import { claudeJsonSchema, stewardPrompt } from "./steward.js";

describe("claudeJsonSchema", () => {
  it("uses the draft-07 dialect accepted by Claude Code", () => {
    const schema = claudeJsonSchema();
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.type).toBe("object");
    expect(JSON.stringify(schema)).toContain('"answer"');
    expect(JSON.stringify(schema)).toContain('"clarification"');
    expect(JSON.stringify(schema)).toContain('"proposal"');
    expect(JSON.stringify(schema)).toContain('"resource"');
    expect(JSON.stringify(schema)).toContain('"changeset"');
    expect(JSON.stringify(schema)).not.toContain('"weave_diff"');
  });
});

describe("stewardPrompt", () => {
  it("routes read-only questions to a direct answer and reserves diffs for side effects", () => {
    const prompt = stewardPrompt({
      text: "你现在在哪个仓库工作？",
      sourceMessageId: "message-1",
      originatorActorId: "human:owner",
      graph: emptyGraph(),
      repositoryId: "repo:demo",
      workspaceId: "repository",
      workspaceName: "demo",
      workspacePath: "/tmp/demo",
      localTimezone: "Asia/Shanghai",
      executorActorId: "agent:claude",
      testCommandId: "test:npm",
      history: [{ role: "user", text: "先看看项目" }],
    });

    expect(prompt).toContain("answer: satisfy a simple/read-only request directly");
    expect(prompt).toContain("changeset: use for every durable definition");
    expect(prompt).toContain("A WorkerSpec is immutable");
    expect(prompt).toContain("production-graph-brainstorm");
    expect(prompt).toContain("Recent conversation");
    expect(prompt).toContain("Local IANA timezone: Asia/Shanghai");
    expect(prompt).toContain("use the provided Local IANA timezone without asking");
    expect(prompt).toContain("Never emit Flow id, status, version, createdAt, or updatedAt");
    expect(prompt).toContain("flowRef:<create operation ID>");
  });
});
