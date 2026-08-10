// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsDrawer } from "./ConnectionsDrawer.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ConnectionsDrawer", () => {
  it("uses a user-owned DingTalk application robot as the default journey", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      im: {
        dingtalk: { id: "connection:dingtalk", phase: "disconnected", message: "尚未连接钉钉机器人", hasCredentials: false, pairingPending: false, cardMode: "markdown", updatedAt: new Date().toISOString() },
        feishu: { id: "connection:feishu", phase: "disconnected", message: "尚未连接飞书机器人", hasCredentials: false, pairingPending: false, messageMode: "markdown", updatedAt: new Date().toISOString() },
      },
      localAgents: [],
      externalDiscoveries: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    render(<ConnectionsDrawer open initialTab="im" onClose={vi.fn()} onError={vi.fn()}/>);

    const heading = await screen.findByRole("heading", { name: "钉钉应用机器人" });
    const section = heading.closest("section");
    expect(section).not.toBeNull();
    const dingTalk = within(section!);
    expect(dingTalk.getByRole("heading", { name: "连接你自己的应用机器人" })).toBeTruthy();
    expect(dingTalk.getByRole("link", { name: /打开钉钉开发者后台/ }).getAttribute("href")).toBe("https://open-dev.dingtalk.com/");
    expect(dingTalk.getByLabelText("Client ID")).toBeTruthy();
    expect(dingTalk.getByLabelText("Client Secret")).toBeTruthy();
    expect(dingTalk.getByRole("button", { name: "验证并连接" })).toBeTruthy();
    expect(section!.textContent).not.toContain("扫码");
    expect(section!.textContent).not.toContain("OpenClaw");
  });
});
