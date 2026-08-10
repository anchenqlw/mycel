import type { ApplicationService } from "@mycel/application";
import { describe, expect, it, vi } from "vitest";
import { FeishuIntegration, type FeishuChannelPort, type FeishuMessage } from "./integration.js";

class FakeChannel implements FeishuChannelPort {
  messageHandler: ((message: FeishuMessage) => void | Promise<void>) | undefined;
  sent: Array<{ to: string; markdown?: string; text?: string; replyTo?: string }> = [];
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  on(name: "message" | "error" | "reconnecting" | "reconnected", handler: ((message: FeishuMessage) => void | Promise<void>) | ((...args: unknown[]) => void)): () => void {
    if (name === "message") this.messageHandler = handler as (message: FeishuMessage) => void | Promise<void>;
    return () => { if (name === "message") this.messageHandler = undefined; };
  }
  async send(to: string, input: { markdown: string } | { text: string }, options?: { replyTo?: string }): Promise<{ messageId: string }> {
    this.sent.push({ to, ...input, ...(options?.replyTo ? { replyTo: options.replyTo } : {}) });
    return { messageId: `reply-${this.sent.length}` };
  }
  async emit(message: Partial<FeishuMessage> = {}): Promise<void> {
    await this.messageHandler?.({ messageId: "msg-1", chatId: "chat-1", chatType: "p2p", senderId: "ou-owner", content: "当前有多少运行？", rawContentType: "text", mentionedBot: false, ...message });
  }
}

describe("FeishuIntegration", () => {
  it("pairs the first private user and forwards the message through the Feishu channel", async () => {
    const channel = new FakeChannel();
    const paired = vi.fn();
    const submitIntent = vi.fn(async () => ({ kind: "answer", replayed: false, response: { text: "当前没有运行中的图。" } }));
    const integration = new FeishuIntegration(
      { submitIntent } as unknown as ApplicationService,
      { appId: "cli_test", appSecret: "secret", allowedOpenIds: [], ownerActorId: "human:owner", pairFirstPrivateUser: true, onOwnerPaired: paired },
      channel,
    );

    await integration.start();
    await channel.emit();

    expect(paired).toHaveBeenCalledWith({ openId: "ou-owner" });
    expect(submitIntent).toHaveBeenCalledWith(expect.objectContaining({ channel: "feishu", conversationId: "chat-1", actorId: "human:owner" }));
    expect(channel.sent).toEqual([{ to: "chat-1", markdown: "当前没有运行中的图。", replyTo: "msg-1" }]);
  });

  it("ignores unmentioned group messages and users other than the bound owner", async () => {
    const channel = new FakeChannel();
    const submitIntent = vi.fn();
    const integration = new FeishuIntegration(
      { submitIntent } as unknown as ApplicationService,
      { appId: "cli_test", appSecret: "secret", allowedOpenIds: ["ou-owner"], ownerActorId: "human:owner" },
      channel,
      { info: vi.fn(), error: vi.fn() },
    );
    await integration.start();

    await channel.emit({ chatType: "group", mentionedBot: false });
    await channel.emit({ senderId: "ou-stranger" });

    expect(submitIntent).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);
  });
});
