import { describe, expect, it } from "vitest";
import { shouldSubmitComposer } from "./composer.js";

describe("shouldSubmitComposer", () => {
  it("submits a plain Enter", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
  });

  it("keeps Shift+Enter as a newline", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
  });

  it("does not submit while an IME composition is active", () => {
    expect(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldSubmitComposer({ key: "Space", shiftKey: false, isComposing: false })).toBe(false);
  });
});
