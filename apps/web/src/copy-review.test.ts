import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const workersSource = readFileSync(new URL("./workers/WorkersView.tsx", import.meta.url), "utf8");

describe("user-facing copy contract", () => {
  it("uses task guidance instead of product-design slogans", () => {
    expect(source).toContain("告诉 Steward 你想完成什么");
    expect(source).toContain("处理分配给你的任务、权限申请和待确认事项");
    expect(workersSource).toContain("查看执行者、Harness 版本和 Session");
    expect(workersSource).toContain("Adopted Worker");
    expect(workersSource).toContain("Native Worker");
    expect(source).not.toContain("从对话到生产关系");
    expect(source).not.toContain("外部 Agent 与 Graph-native Agent 同权同显");
    expect(source).not.toContain('title="Agents"');
    expect(source).not.toContain("Graph Agent");
  });

  it("does not render native select controls", () => {
    expect(source).not.toContain("<select");
    expect(workersSource).not.toContain("<select");
  });
});
