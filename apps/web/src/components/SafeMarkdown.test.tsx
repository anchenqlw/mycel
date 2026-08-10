import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SafeMarkdown } from "./SafeMarkdown.js";

describe("SafeMarkdown", () => {
  it("renders common agent Markdown instead of exposing markers", () => {
    const html = renderToStaticMarkup(<SafeMarkdown content={"**重要**\n\n- 第一项\n- 第二项\n\n`npm test`"}/>);
    expect(html).toContain("<strong>重要</strong>");
    expect(html).toContain("<li>第一项</li>");
    expect(html).toContain("<code>npm test</code>");
    expect(html).not.toContain("**重要**");
  });

  it("drops raw HTML and dangerous link protocols", () => {
    const html = renderToStaticMarkup(<SafeMarkdown content={'<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[good](https://example.com)'}/>);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});
