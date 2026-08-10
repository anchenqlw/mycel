export interface TextReplyTransport {
  reply(sessionWebhook: string, text: string): Promise<void>;
}

export class DingTalkSessionWebhookTextTransport implements TextReplyTransport {
  readonly #fetch: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.#fetch = fetchImpl;
  }

  async reply(sessionWebhook: string, text: string): Promise<void> {
    const url = new URL(sessionWebhook);
    if (url.protocol !== "https:") throw new Error("DingTalk session webhook must use HTTPS");
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: text } }),
    });
    if (!response.ok) throw new Error(`DingTalk text reply failed: HTTP ${response.status}`);
    const body = await response.json() as { errcode?: number; errmsg?: string };
    if (body.errcode !== undefined && body.errcode !== 0) {
      throw new Error(`DingTalk text reply failed: ${body.errmsg ?? `errcode ${body.errcode}`}`);
    }
  }
}
