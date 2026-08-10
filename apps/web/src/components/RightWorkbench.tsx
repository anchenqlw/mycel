import type React from "react";
import { keyboardTabTarget, type RightWorkbenchState, type RightWorkbenchTab } from "../right-workbench.js";

export function RightWorkbench({ state, collapsed, productionBadge, onActivate, onClose, onToggleCollapsed, renderPanel }: {
  state: RightWorkbenchState;
  collapsed: boolean;
  productionBadge: number;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onToggleCollapsed: () => void;
  renderPanel: (tab: RightWorkbenchTab) => React.ReactNode;
}) {
  const active = state.tabs.find((tab) => tab.key === state.activeKey) ?? state.tabs[0]!;
  function onKeyDown(event: React.KeyboardEvent) {
    const target = keyboardTabTarget(state, event.key);
    if (!target) return;
    event.preventDefault();
    onActivate(target);
    requestAnimationFrame(() => document.getElementById(`right-tab-${cssId(target)}`)?.focus());
  }
  return <aside className={`right-workbench ${collapsed ? "collapsed" : ""}`} aria-label="右侧工作栏">
    <header className="right-workbench-header"><div><span className="eyebrow">CONTEXT WORKBENCH</span><b>{collapsed ? String(productionBadge) : active.label}</b></div><button type="button" aria-expanded={!collapsed} aria-label={collapsed ? "展开右侧工作栏" : "收起右侧工作栏"} onClick={onToggleCollapsed}>{collapsed ? "‹" : "›"}</button></header>
    {!collapsed && <><div className="right-tabs" role="tablist" aria-label="工作栏标签" onKeyDown={onKeyDown}>{state.tabs.map((tab) => <div className="right-tab-shell" key={tab.key}><button id={`right-tab-${cssId(tab.key)}`} type="button" role="tab" aria-selected={tab.key === active.key} aria-controls={`right-panel-${cssId(tab.key)}`} tabIndex={tab.key === active.key ? 0 : -1} onClick={() => onActivate(tab.key)}><span>{tab.label}</span>{tab.kind === "production" && productionBadge > 0 && <em>{productionBadge}</em>}</button>{tab.closable && <button type="button" className="right-tab-close" aria-label={`关闭 ${tab.label}`} onClick={() => onClose(tab.key)}>×</button>}</div>)}</div><div id={`right-panel-${cssId(active.key)}`} className="right-workbench-panel" role="tabpanel" aria-labelledby={`right-tab-${cssId(active.key)}`}>{renderPanel(active)}</div></>}
  </aside>;
}

function cssId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
