// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openResourceTab, initialRightWorkbenchState } from "../right-workbench.js";
import { RightWorkbench } from "./RightWorkbench.js";

afterEach(cleanup);

describe("RightWorkbench", () => {
  it("renders accessible tabs, panels, badges, and close controls", () => {
    const state = openResourceTab(initialRightWorkbenchState, { kind: "run", id: "run-1", label: "Run one" });
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(<RightWorkbench state={state} collapsed={false} productionBadge={3} onActivate={onActivate} onClose={onClose} onToggleCollapsed={vi.fn()} renderPanel={(tab) => <p>{tab.label} panel</p>}/>);
    expect(screen.getByRole("tablist", { name: "工作栏标签" })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tabpanel").textContent).toContain("Run one panel");
    fireEvent.click(screen.getByRole("button", { name: "关闭 Run one" }));
    expect(onClose).toHaveBeenCalledWith("run:run-1");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "Home" });
    expect(onActivate).toHaveBeenCalledWith("production");
  });
});
