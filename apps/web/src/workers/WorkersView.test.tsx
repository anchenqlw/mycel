// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkersView, type WorkersProjection } from "./WorkersView.js";

afterEach(cleanup);

const state: WorkersProjection = {
  workers: {
    "worker:claude": {
      id: "worker:claude", name: "Claude Code", source: "adopted", adapterKind: "claude-code", status: "online",
      capabilities: ["repository-read", "repository-write"], contractLevel: "control", lifecycle: "persistent",
      defaultSpecVersionId: "worker-spec:claude:v2",
      controlCapabilities: { send: true, interrupt: true, resume: true, cancel: true, fork: true, structuredOutput: true },
    },
    "worker:reviewer": {
      id: "worker:reviewer", name: "Review Worker", source: "native", adapterKind: "codex", status: "online",
      capabilities: ["repository-read"], contractLevel: "control", lifecycle: "flow-scoped",
      defaultSpecVersionId: "worker-spec:reviewer:v1",
      controlCapabilities: { send: true, interrupt: true, resume: true, cancel: true, fork: false, structuredOutput: true },
    },
  },
  workerSpecs: {
    "worker-spec:claude:v2": {
      schemaVersion: 2, id: "worker-spec:claude:v2", workerId: "worker:claude", version: 2,
      systemPrompt: "Inspect the selected workspace and preserve evidence.", engine: { adapter: "claude-code", model: "sonnet" },
      skills: [{ name: "evidence-first", enabled: true, content: "" }], mcpServers: [],
      tools: [{ name: "Read", permission: "allow", enabled: true }], fileRefs: [], lifecycle: "persistent",
      memory: { scope: "worker", resume: true, summaryPolicy: "compact" }, sessionPolicy: { maxTurns: 20, maxConcurrentSessions: 1 },
      orchestration: { enabled: false, maxDelegationDepth: 0, maxFanOut: 0 },
    },
    "worker-spec:reviewer:v1": {
      schemaVersion: 2, id: "worker-spec:reviewer:v1", workerId: "worker:reviewer", version: 1,
      systemPrompt: "Review changes.", engine: { adapter: "codex" }, skills: [], mcpServers: [], tools: [], fileRefs: [], lifecycle: "flow-scoped",
      orchestration: { enabled: false, maxDelegationDepth: 0, maxFanOut: 0 },
    },
  },
  workerSessions: {
    "worker-session:one": { id: "worker-session:one", workerId: "worker:claude", phase: "completed", mode: "explore", instruction: "inspect", summary: "Repository inspected", lastEvent: "Completed", workerSpecVersionId: "worker-spec:claude:v2", updatedAt: "2026-08-05T10:00:00.000Z" },
  },
  agentSessions: {},
};

describe("WorkersView", () => {
  it("shows adopted/native workers, immutable Harness versions, and sessions", () => {
    render(<WorkersView state={state} workspaceId="repository" onError={vi.fn()} onOpenConnections={vi.fn()} onOpenResource={vi.fn()} onAskSteward={vi.fn()}/>);
    expect(screen.getByRole("heading", { name: "Workers" })).toBeInTheDocument();
    expect(screen.getByText("Adopted Worker")).toBeInTheDocument();
    expect(screen.getByText("Native Worker")).toBeInTheDocument();
    expect(screen.getByText("WorkerSpec v2")).toBeInTheDocument();
    expect(screen.getByText("Repository inspected")).toBeInTheDocument();
  });

  it("switches workers and delegates Harness changes to Steward", () => {
    const ask = vi.fn();
    render(<WorkersView state={state} workspaceId="repository" onError={vi.fn()} onOpenConnections={vi.fn()} onOpenResource={vi.fn()} onAskSteward={ask}/>);
    fireEvent.click(screen.getByRole("button", { name: /Review Worker/ }));
    expect(screen.getByText("WorkerSpec v1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /让 Steward 修改 Harness/ }));
    expect(ask).toHaveBeenCalledWith(expect.stringContaining("worker:reviewer"));
  });
});
