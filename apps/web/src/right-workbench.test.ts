import { describe, expect, it } from "vitest";
import { activateRightTab, closeRightTab, initialRightWorkbenchState, keyboardTabTarget, openResourceTab } from "./right-workbench.js";

const run = { kind: "run" as const, id: "run-1", label: "Run one" };
const file = { kind: "file" as const, id: "README.md", label: "README", path: "README.md" };
const changeSet = { kind: "changeset" as const, id: "changeset-1", label: "Create worker" };

describe("right workbench state", () => {
  it("opens resource tabs, deduplicates them, and keeps production fixed", () => {
    const one = openResourceTab(initialRightWorkbenchState, run);
    const duplicate = openResourceTab(one, run);
    const two = openResourceTab(duplicate, file);
    expect(two.tabs.map((tab) => tab.key)).toEqual(["production", "run:run-1", "file:README.md"]);
    expect(two.activeKey).toBe("file:README.md");
    expect(closeRightTab(two, "production")).toBe(two);
  });

  it("closes active and background tabs with deterministic fallback", () => {
    const state = openResourceTab(openResourceTab(initialRightWorkbenchState, run), file);
    const backgroundClosed = closeRightTab(state, "run:run-1");
    expect(backgroundClosed.activeKey).toBe("file:README.md");
    const activeClosed = closeRightTab(backgroundClosed, "file:README.md");
    expect(activeClosed).toEqual(initialRightWorkbenchState);
    expect(activateRightTab(state, "missing")).toBe(state);
  });

  it("calculates wrapping keyboard navigation targets", () => {
    const state = openResourceTab(openResourceTab(initialRightWorkbenchState, run), file);
    expect(keyboardTabTarget(state, "Home")).toBe("production");
    expect(keyboardTabTarget(state, "End")).toBe("file:README.md");
    expect(keyboardTabTarget(state, "ArrowRight")).toBe("production");
    expect(keyboardTabTarget(activateRightTab(state, "production"), "ArrowLeft")).toBe("file:README.md");
    expect(keyboardTabTarget(state, "Enter")).toBeUndefined();
  });

  it("opens first-class control resources", () => {
    const state = openResourceTab(initialRightWorkbenchState, changeSet);
    expect(state.activeKey).toBe("changeset:changeset-1");
    expect(state.tabs[1]).toMatchObject({ kind: "resource", resource: changeSet });
  });
});
