import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("starts in Web-only mode when DingTalk is not configured", () => {
    const config = loadConfig({}, "/tmp/mycel-config-test");
    expect(config.dingtalk).toBeUndefined();
    expect(config.executor.timeoutMs).toBe(300_000);
    expect(config.testCommandArgv).toEqual(["npm", "test"]);
  });

  it("rejects partial DingTalk credentials", () => {
    expect(() => loadConfig({ DINGTALK_CLIENT_ID: "ding-app" }, "/tmp/mycel-config-test"))
      .toThrow("DingTalk configuration is partial");
  });

  it("parses the owner allowlist", () => {
    const config = loadConfig({
      DINGTALK_CLIENT_ID: "ding-app",
      DINGTALK_CLIENT_SECRET: "secret",
      DINGTALK_CARD_TEMPLATE_ID: "template.schema",
      DINGTALK_ALLOWED_USER_IDS: "owner-1, owner-2",
      DINGTALK_ROBOT_CODE: "robot",
    }, "/tmp/mycel-config-test");
    expect(config.dingtalk?.allowedUserIds).toEqual(["owner-1", "owner-2"]);
  });
});
