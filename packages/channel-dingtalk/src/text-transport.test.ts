import { describe, expect, it, vi } from "vitest";
import { DingTalkSessionWebhookTextTransport } from "./text-transport.js";

describe("DingTalkSessionWebhookTextTransport", () => {
  it("replies with a DingTalk text message", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ errcode: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const transport = new DingTalkSessionWebhookTextTransport(fetchImpl as typeof fetch);

    await transport.reply("https://oapi.dingtalk.com/robot/sendBySession?session=secret", "当前仓库是 demo-repo。\n");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("oapi.dingtalk.com/robot/sendBySession");
    expect(JSON.parse(String(init?.body))).toEqual({
      msgtype: "text",
      text: { content: "当前仓库是 demo-repo。\n" },
    });
  });

  it("rejects non-HTTPS webhooks", async () => {
    const transport = new DingTalkSessionWebhookTextTransport();
    await expect(transport.reply("http://localhost/hook", "hello")).rejects.toThrow("must use HTTPS");
  });
});
