import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("Steward conversation layout contract", () => {
  it("renders the active design inside the scrollable conversation", () => {
    const conversationStart = source.indexOf('className="conversation-log steward-conversation"');
    const designCard = source.indexOf("<DesignSessionCard session={activeDesign}/>", conversationStart);
    const composer = source.indexOf('className="conversation-composer"', conversationStart);
    expect(conversationStart).toBeGreaterThan(-1);
    expect(designCard).toBeGreaterThan(conversationStart);
    expect(designCard).toBeLessThan(composer);
    expect(source).not.toContain('<div className="design-ribbon"');
  });

  it("keeps Live Production out of the conversation and defines an independent right rail", () => {
    expect(source).not.toContain("conversation-activity ${productionExpanded");
    expect(source).toContain("<LiveProductionPanel");
    expect(styles).toContain(".right-workbench-panel { min-width: 0; min-height: 0; flex: 1; overflow-y: auto;");
    expect(styles).toContain(".design-open-question p");
  });

  it("uses a flat Steward-first sidebar without category labels or actor shortcuts", () => {
    expect(source).toContain('const primaryNavigation: Surface[] = ["steward", "now", "graph", "workers", "flows", "files", "history"]');
    expect(source).not.toContain('<NavGroup label="ATTENTION"');
    expect(source).not.toContain('<NavGroup label="PRODUCTION"');
    expect(source).not.toContain('<NavGroup label="LUI"');
    expect(source).not.toContain('className="actor-list"');
  });
});

describe("narrow production controls", () => {
  it("reserves the collapsed workbench rail and reflows the Steward composer footer", () => {
    expect(styles).toMatch(/@media \(max-width: 1200px\)[\s\S]*\.workbench\.has-right-workbench\.right-workbench-collapsed\s*\{[^}]*grid-template-columns:\s*190px minmax\(0,1fr\) 54px/);
    expect(styles).toMatch(/@media \(max-width: 900px\)[\s\S]*\.conversation-composer footer\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\) auto/);
  });

  it("contains Human Task claim and reassignment controls in dedicated layouts", () => {
    expect(styles).toMatch(/\.human-task-actions\s*\{[^}]*display:\s*grid/);
    expect(styles).toMatch(/\.human-task-reassign\s*\{[^}]*display:\s*grid/);
    expect(styles).toMatch(/@media \(max-width: 900px\)[\s\S]*\.human-task-reassign\s*\{[^}]*grid-template-columns:\s*1fr/);
  });

  it("shows safe regeneration on every incomplete applied ChangeSet surface", () => {
    expect(source).not.toMatch(/status === "failed" && <FailedChangeSetRecoveryAction/);
    expect(source.match(/isRecoverableChangeSetStatus\([^)]*\.status\)/g)).toHaveLength(3);
  });

  it("projects Flow runtime failures safely on every run summary surface", () => {
    expect(source.match(/flowRunPresentationMessage\(run\.message/g)).toHaveLength(3);
    expect(source).not.toContain("<p>{run.message}</p>");
    expect(source).toMatch(/async function retry\(\)[^{]*\{[\s\S]*?onError\(friendlyError\(cause\)\)/);
    expect(source).toMatch(/async function replace\([^)]*\)[^{]*\{[\s\S]*?onError\(friendlyError\(cause\)\)/);
  });

  it("routes every Task result surface through the shared presentation boundary", () => {
    expect(source.match(/taskPresentationMessage\(task\)/g)).toHaveLength(3);
    expect(source).not.toMatch(/task\.resultSummary\s*\?\?\s*task\.description/);
    expect(source).not.toContain("<p>{task.resultSummary}</p>");
  });

});
