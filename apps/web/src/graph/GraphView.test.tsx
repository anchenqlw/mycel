// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphView, wrapGraphLabel } from "./GraphView.js";

afterEach(cleanup);

describe("Graph label containment", () => {
  it("wraps long public fixture labels only at word boundaries", () => {
    expect(wrapGraphLabel("Local Research Worker", 18)).toEqual(["Local Research", "Worker"]);
    expect(wrapGraphLabel("Record publication readiness", 18)).toEqual(["Record publication", "readiness"]);
  });

  it("renders a non-shrinking graph canvas inside its stage", () => {
    render(<GraphView state={{
      graph: { version: 1, nodes: [{ id: "worker:researcher", name: "Local Research Worker", type: "actor", kind: "agent", status: "online" }], edges: [] },
      flows: {}, flowRuns: {}, stepRuns: {}, stepResults: {}, permissionLeases: {},
    }} selected="" onSelect={vi.fn()} onInspect={vi.fn()}/>);
    const svg = screen.getByRole("application", { name: "统一动态生产图" });
    expect(svg).toHaveClass("graph-canvas");
    expect(svg).toHaveStyle({ minWidth: "1160px" });
    expect(screen.getByRole("button", { name: /actor Local Research Worker/ })).toHaveTextContent("Local ResearchWorker");
  });
});
