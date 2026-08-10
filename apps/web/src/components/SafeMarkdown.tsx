import React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export function SafeMarkdown({ content, className = "markdown-content" }: { content: string; className?: string }) {
  return <MarkdownBoundary key={content} fallback={content} className={className}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={safeUrl}
      components={{
        a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
        pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
      }}
    >{content}</ReactMarkdown>
  </MarkdownBoundary>;
}

class MarkdownBoundary extends React.Component<React.PropsWithChildren<{ fallback: string; className: string }>, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    if (this.state.failed) return <div className={this.props.className}><p>{this.props.fallback}</p></div>;
    return <div className={this.props.className}>{this.props.children}</div>;
  }
}

function safeUrl(url: string): string {
  const normalized = url.trim();
  if (/^(https?:|mailto:|#|\/)/i.test(normalized)) return defaultUrlTransform(normalized);
  return "";
}
