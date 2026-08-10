export interface RightWorkbenchResource {
  kind: "graph" | "agent" | "worker" | "worker-spec" | "flow" | "run" | "flow-run" | "task" | "worker-session" | "human-task" | "workspace" | "file" | "evidence" | "history" | "changeset";
  id: string;
  label: string;
  workspaceId?: string;
  path?: string;
}

export type RightWorkbenchTab =
  | { key: "production"; kind: "production"; label: "Live Production"; closable: false }
  | { key: string; kind: "resource"; label: string; closable: true; resource: RightWorkbenchResource };

export interface RightWorkbenchState {
  tabs: RightWorkbenchTab[];
  activeKey: string;
}

export const productionTab: RightWorkbenchTab = { key: "production", kind: "production", label: "Live Production", closable: false };
export const initialRightWorkbenchState: RightWorkbenchState = { tabs: [productionTab], activeKey: productionTab.key };

export function resourceTabKey(resource: RightWorkbenchResource): string {
  return `${resource.kind}:${resource.id}`;
}

export function openResourceTab(state: RightWorkbenchState, resource: RightWorkbenchResource): RightWorkbenchState {
  const key = resourceTabKey(resource);
  const existing = state.tabs.find((tab) => tab.key === key);
  if (existing) return { tabs: state.tabs, activeKey: key };
  return { tabs: [...state.tabs, { key, kind: "resource", label: resource.label, closable: true, resource }], activeKey: key };
}

export function activateRightTab(state: RightWorkbenchState, key: string): RightWorkbenchState {
  return state.tabs.some((tab) => tab.key === key) ? { ...state, activeKey: key } : state;
}

export function closeRightTab(state: RightWorkbenchState, key: string): RightWorkbenchState {
  const index = state.tabs.findIndex((tab) => tab.key === key);
  if (index <= 0) return state;
  const tabs = state.tabs.filter((tab) => tab.key !== key);
  if (state.activeKey !== key) return { tabs, activeKey: state.activeKey };
  return { tabs, activeKey: tabs[Math.max(0, index - 1)]?.key ?? productionTab.key };
}

export function keyboardTabTarget(state: RightWorkbenchState, key: string): string | undefined {
  const index = Math.max(0, state.tabs.findIndex((tab) => tab.key === state.activeKey));
  if (key === "Home") return state.tabs[0]?.key;
  if (key === "End") return state.tabs.at(-1)?.key;
  if (key === "ArrowRight") return state.tabs[(index + 1) % state.tabs.length]?.key;
  if (key === "ArrowLeft") return state.tabs[(index - 1 + state.tabs.length) % state.tabs.length]?.key;
  return undefined;
}
