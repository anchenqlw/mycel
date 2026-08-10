// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FailedChangeSetRecoveryAction,
  HistoryEventPayload,
  HumanTaskOpenActions,
  humanTaskPresentationTitle,
  eligibleReplacementWorkers,
  flowRunPresentationMessage,
  isRecoverableChangeSetStatus,
  stepRunPresentationMessage,
  taskPresentationMessage,
  UnsupportedFileNotice,
  WorkerStepRecoveryActions,
} from "./PresentationSafety.js";

afterEach(cleanup);

describe("presentation safety controls", () => {
  it("routes failed ChangeSet recovery to Steward regeneration without applying anything", () => {
    const onAskSteward = vi.fn();
    render(<FailedChangeSetRecoveryAction changeSetId="changeset:failed" title="Publish release review" status="failed" onAskSteward={onAskSteward}/>);
    fireEvent.click(screen.getByRole("button", { name: /让 Steward 重新生成/ }));
    expect(onAskSteward).toHaveBeenCalledOnce();
    expect(onAskSteward).toHaveBeenCalledWith(expect.stringMatching(/changeset:failed.*当前 Graph/s));
    expect(screen.queryByRole("button", { name: /应用|重试/ })).not.toBeInTheDocument();
  });

  it("offers the same safe regeneration for partially applied ChangeSets", () => {
    expect(isRecoverableChangeSetStatus("failed")).toBe(true);
    expect(isRecoverableChangeSetStatus("partially-applied")).toBe(true);
    expect(isRecoverableChangeSetStatus("awaiting-approval")).toBe(false);
    expect(isRecoverableChangeSetStatus("applied")).toBe(false);

    render(<FailedChangeSetRecoveryAction changeSetId="changeset:partial" title="Publish release review" status="partially-applied" onAskSteward={vi.fn()}/>);
    expect(screen.getByText(/已成功应用的变更会保留/)).toBeInTheDocument();
    expect(screen.getByText(/不会自动重放/)).toBeInTheDocument();
    expect(screen.queryByText(/Graph 保持不变/)).not.toBeInTheDocument();
  });

  it("uses the Flow step name for a Human Task and keeps narrow actions in dedicated rows", () => {
    const title = humanTaskPresentationTitle({
      task: { stepRunId: "step-run:approval" },
      stepRuns: { "step-run:approval": { flowRunId: "run:1", stepId: "approve", message: "Waiting for human:owner" } },
      flowRuns: { "run:1": { flowId: "flow:release" } },
      flows: { "flow:release": { steps: [{ id: "approve", name: "Owner approval" }] } },
    });
    expect(title).toBe("Owner approval");
    expect(stepRunPresentationMessage({
      phase: "blocked",
      message: "Waiting for human:owner",
      stepKind: "human",
      actorName: "Demo Owner",
    })).toBe("等待 Demo Owner 处理");
    const failedMessage = stepRunPresentationMessage({
      phase: "failed",
      message: "agent is not registered: worker:native:release-steward",
      stepKind: "agent",
      actorName: "Release Steward",
    });
    expect(failedMessage).toMatch(/Worker.*本地执行适配器/);
    expect(failedMessage).not.toMatch(/worker:native|agent is not registered/);
    const workspaceMessage = stepRunPresentationMessage({
      phase: "failed",
      message: "workspace is not registered: repository:public-demo",
      stepKind: "agent",
      actorName: "Release Steward",
    });
    expect(workspaceMessage).toMatch(/Worker.*Workspace.*重试/);
    expect(workspaceMessage).not.toMatch(/repository:public-demo|workspace is not registered/);
    const runMessage = flowRunPresentationMessage("workspace is not registered: repository:public-demo", "No progress yet");
    expect(runMessage).toMatch(/Worker.*Workspace.*失败步骤/);
    expect(runMessage).not.toMatch(/repository:public-demo|workspace is not registered/);

    render(<HumanTaskOpenActions humans={[{ id: "human:owner", name: "Demo Owner" }]} value="human:owner" onChange={vi.fn()} onClaim={vi.fn()} onReassign={vi.fn()}/>);
    expect(screen.getByRole("button", { name: "领取任务" }).parentElement).toHaveClass("human-task-actions");
    expect(screen.getByLabelText("选择新的处理人").parentElement?.parentElement).toHaveClass("human-task-reassign");
  });

  it("offers only online local adapters as replacement Workers", () => {
    const eligible = eligibleReplacementWorkers([
      { id: "agent:claude", name: "Claude Worker", status: "online", adapterKind: "claude-code" },
      { id: "agent:codex", name: "Codex Worker", status: "online", adapterKind: "codex" },
      { id: "agent:degraded", name: "Degraded Worker", status: "degraded", adapterKind: "claude-code" },
      { id: "agent:mcp", name: "External Worker", status: "online", adapterKind: "mcp" },
      { id: "agent:offline", name: "Offline Worker", status: "offline", adapterKind: "codex" },
    ]);
    expect(eligible).toEqual([
      { id: "agent:claude", name: "Claude Worker", status: "online", adapterKind: "claude-code" },
      { id: "agent:codex", name: "Codex Worker", status: "online", adapterKind: "codex" },
    ]);
  });

  it("retries through the UI and replaces a missing Worker with the visible eligible selection", () => {
    const onRetry = vi.fn();
    const onReplace = vi.fn();
    render(<WorkerStepRecoveryActions
      agents={[
        { id: "agent:claude", name: "Claude Worker", status: "online", adapterKind: "claude-code" },
        { id: "agent:mcp", name: "External Worker", status: "online", adapterKind: "mcp" },
      ]}
      currentActorId="worker:native:release-steward"
      onRetry={onRetry}
      onReplace={onReplace}
    />);
    const replacement = screen.getByLabelText("选择替换 Worker（本地执行适配器）");
    expect(replacement).toHaveTextContent("Claude Worker");
    fireEvent.click(replacement);
    expect(screen.queryByRole("option", { name: "External Worker" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试 Worker" }));
    fireEvent.click(screen.getByRole("button", { name: "替换 Worker" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onReplace).toHaveBeenCalledWith("agent:claude");
    expect(screen.getByText(/本地执行适配器/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("本地 Agent 适配器");
  });

  it("projects a failed Task result through the same safe Worker boundary", () => {
    const message = taskPresentationMessage({
      description: "Record publication readiness",
      resultSummary: "agent is not registered: worker:native:release-steward",
    });
    expect(message).toMatch(/Worker.*本地执行适配器/);
    expect(message).not.toMatch(/agent is not registered|worker:native:release-steward/);
  });

  it("renders only sanitized History payloads", () => {
    render(<HistoryEventPayload payload={{ id: "run:1", phase: "failed", summary: "Safe summary", prompt: "private prompt", argv: ["private-command"], token: "private-token" }}/>);
    expect(screen.getByText(/Safe summary/)).toBeInTheDocument();
    expect(screen.getByText(/run:1/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/private prompt|private-command|private-token/);
  });

  it("labels an unsupported file by safe basename only", () => {
    const onOpen = vi.fn();
    render(<UnsupportedFileNotice relativePath="fixtures/release-review.demoasset" error="file type is not supported" onOpen={onOpen}/>);
    expect(screen.getByText("release-review.demoasset")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("fixtures/release-review.demoasset");
    fireEvent.click(screen.getByRole("button", { name: /系统默认应用/ }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
