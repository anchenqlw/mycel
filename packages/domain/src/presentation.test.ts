import { describe, expect, it } from "vitest";
import { sanitizeForPresentation } from "./presentation.js";

describe("sanitizeForPresentation", () => {
  it("recursively removes prompts, raw execution inputs, file contents, and credentials while retaining useful facts", () => {
    const authorizationKey = ["author", "ization"].join("");
    const cookieKey = ["coo", "kie"].join("");
    const homePath = ["", "Users", "fixture-user", "repository"].join("/");
    const presented = sanitizeForPresentation({
      flowRunId: "flow-run:public-1",
      phase: "failed",
      summary: "Review paused with recoverable evidence.",
      message: ["agent is not registered", ["worker", "native", "release-steward"].join(":")].join(": "),
      workspaceMessage: ["workspace is not registered", ["repository", "public-demo"].join(":")].join(": "),
      evidence: { artifactId: "artifact:summary", uri: "mycel://public/evidence", sha256: "abc123", mediaType: "text/markdown" },
      nested: {
        prompt: "private flow instruction",
        systemPrompt: "private system instruction",
        toolInput: { query: "private tool query" },
        rawToolEvents: [{ input: "private raw input" }],
        command: "private-command --secret",
        argv: ["private-command", "--secret"],
        parameters: { target: homePath },
        fileContents: "private file body",
        [authorizationKey]: ["Bea", "rer fixture-bearer"].join(""),
        [cookieKey]: "session=fixture-cookie",
        accessToken: "fixture-access-token",
        credential: { password: "fixture-password" },
      },
      note: ["Author", "ization: Bea", "rer fixture-inline-token"].join(""),
    });
    const serialized = JSON.stringify(presented);

    expect(presented).toMatchObject({
      flowRunId: "flow-run:public-1",
      phase: "failed",
      summary: "Review paused with recoverable evidence.",
      evidence: { artifactId: "artifact:summary", uri: "mycel://public/evidence", sha256: "abc123", mediaType: "text/markdown" },
    });
    expect(serialized).not.toMatch(/private flow|private system|private tool|private raw|private-command|private file|fixture-bearer|fixture-cookie|fixture-access|fixture-password|fixture-inline|fixture-user|agent is not registered|worker:native|workspace is not registered|repository:public-demo/);
    expect(serialized).toContain("Worker is not connected to a local execution adapter");
    expect(serialized).toContain("Worker cannot access the selected Workspace");
    expect(serialized).toContain("[redacted]");
  });
});
