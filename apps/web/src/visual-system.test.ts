import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const graphStyles = readFileSync(new URL("./graph/graph.css", import.meta.url), "utf8");

describe("demo visual system readability contract", () => {
  it("defines the approved high-contrast paper and status palette", () => {
    expect(styles).toContain("--bg: #1a1a1c");
    expect(styles).toContain("--paper: #f4f1df");
    expect(styles).toContain("--ink: #161616");
    expect(styles).toContain("--lime: #c6ff4a");
    expect(styles).toContain("--yellow: #ffc843");
    expect(styles).toContain("--red: #ff5d8f");
  });

  it("keeps core conversation text at readable sizes", () => {
    expect(styles).toContain(".semantic-card > p { color: var(--ink-2); font-size: 13px;");
    expect(styles).toContain(".conversation-composer textarea { min-height: 70px; color: var(--ink); font-size: 14px;");
    expect(styles).toContain(".info span,.inspector-result > span { color: var(--muted); font-size: 10px;");
  });

  it("uses the approved paper Markdown and neutral code treatment", () => {
    const start = styles.indexOf(".markdown-content {");
    const end = styles.indexOf("@media (max-width: 1200px)", start);
    const markdownStyles = styles.slice(start, end);
    expect(markdownStyles).toContain("color: var(--ink-2)");
    expect(markdownStyles).toContain(".markdown-content strong { color: var(--ink)");
    expect(markdownStyles).toContain(".markdown-content code { padding: 2px 6px; color: #231f39; border: 1px solid #aaa4bf;");
    expect(markdownStyles).toContain("background: #e5e2ee; font: .9em/1.5 var(--mono)");
    expect(markdownStyles).toContain("border-left: 7px solid var(--violet); background: #202026");
    expect(markdownStyles).toContain(".markdown-content pre code { padding: 0; color: #ddd9ee; border: 0;");
    expect(markdownStyles).toContain("border-radius: 0; background: transparent; white-space: pre;");
    expect(markdownStyles).not.toContain("background: var(--lime)");
  });

  it("keeps graph labels readable after viewBox scaling", () => {
    expect(graphStyles).toContain(".node-title { fill: var(--ink);");
    expect(graphStyles).toContain("font-size: 19px; font-weight: 700; }.node-meta");
    expect(graphStyles).toContain(".node-meta { fill: var(--ink-2); font-size: 18px;");
    expect(graphStyles).toContain(".graph-legend { gap: 17px; padding-top: 13px; color: var(--text); font-size: 10px;");
    expect(graphStyles).toContain(".node-title { font-size: 14px; }");
    expect(graphStyles).toContain(".node-meta { font-size: 10px;");
  });

  it("defines compact session and custom listbox contracts", () => {
    expect(styles).toContain(".session-compose { grid-template-columns: minmax(150px,190px) minmax(140px,1fr) auto; align-items: start;");
    expect(styles).toContain(".session-compose .select-trigger,.session-compose textarea,.session-compose > button { height: 56px; min-height: 56px;");
    expect(styles).toContain(".select-options { position: absolute; z-index: 120;");
    expect(styles).not.toContain(".mycel-cursor-ring");
    expect(styles).not.toContain("cursor: none !important");
  });
});
