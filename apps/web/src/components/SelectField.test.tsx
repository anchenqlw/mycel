// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectField } from "./SelectField.js";

const options = [
  { value: "explore", label: "只读检查", description: "不会修改工作区" },
  { value: "execute", label: "执行任务", description: "允许写入工作区" },
];

afterEach(cleanup);

describe("SelectField", () => {
  it("opens a styled listbox and selects an option with the mouse", () => {
    const onChange = vi.fn();
    render(<SelectField ariaLabel="选择任务模式" value="explore" options={options} onChange={onChange}/>);
    fireEvent.click(screen.getByRole("combobox", { name: "选择任务模式" }));
    expect(screen.getByRole("listbox", { name: "选择任务模式" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /执行任务/ }));
    expect(onChange).toHaveBeenCalledWith("execute");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("supports arrow keys, Enter, and Escape", () => {
    const onChange = vi.fn();
    render(<SelectField ariaLabel="选择任务模式" value="explore" options={options} onChange={onChange}/>);
    const trigger = screen.getByRole("combobox", { name: "选择任务模式" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("execute");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
