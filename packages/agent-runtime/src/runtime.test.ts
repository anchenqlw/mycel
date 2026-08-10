import { describe, expect, it } from "vitest";
import { controlCapabilitiesForAdapter } from "./runtime.js";

describe("Worker adapter capabilities", () => {
  it("reports only controls supported by the installed CLI contracts", () => {
    expect(controlCapabilitiesForAdapter("claude-code")).toEqual({ send: true, interrupt: true, resume: true, cancel: true, fork: true, structuredOutput: true });
    expect(controlCapabilitiesForAdapter("codex")).toMatchObject({ resume: true, fork: false, cancel: true });
  });
});
