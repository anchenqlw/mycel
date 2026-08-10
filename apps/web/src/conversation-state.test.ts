import { describe, expect, it } from "vitest";
import { shouldShowActiveDesign } from "./conversation-state.js";

describe("conversation state", () => {
  it("hides a stale clarification after a newer unrelated message", () => {
    expect(shouldShowActiveDesign("2026-08-05T10:00:00.000Z", "2026-08-05T10:01:00.000Z")).toBe(false);
  });

  it("shows the clarification produced for the latest message", () => {
    expect(shouldShowActiveDesign("2026-08-05T10:01:01.000Z", "2026-08-05T10:01:00.000Z")).toBe(true);
  });
});
