// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceContextBar } from "./WorkspaceContextBar.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("WorkspaceContextBar", () => {
  it("does not create a nested form inside the conversation composer", () => {
    const { container } = render(<form><WorkspaceContextBar
      workspaces={[{ id: "repository", name: "demo", kind: "repository", path: "/tmp/demo" }]}
      current={{ id: "repository", name: "demo", kind: "repository", path: "/tmp/demo" }}
      disabled={false}
      onRefresh={async () => undefined}
      onSelected={vi.fn()}
      onError={vi.fn()}
    /></form>);

    const trigger = screen.getByRole("button", { name: /Workspace: demo/ });
    expect(trigger.className).toContain("compact");
    expect(trigger.getAttribute("title")).toContain("/tmp/demo");
    fireEvent.click(trigger);
    expect(container.querySelector("form form")).toBeNull();
    expect(screen.getByRole("button", { name: "添加并切换" }).getAttribute("type")).toBe("button");
  });

  it("removes a registered workspace without sending an empty JSON body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ removed: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkspaceContextBar
      workspaces={[
        { id: "repository", name: "demo", kind: "repository", path: "/tmp/demo" },
        { id: "extra", name: "extra", kind: "directory", path: "/tmp/extra" },
      ]}
      current={{ id: "repository", name: "demo", kind: "repository", path: "/tmp/demo" }}
      disabled={false}
      onRefresh={async () => undefined}
      onSelected={vi.fn()}
      onError={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: /Workspace: demo/ }));
    fireEvent.click(screen.getByRole("button", { name: "移除 extra" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({});
  });
});
