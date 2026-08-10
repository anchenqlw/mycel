import { useMemo, useState } from "react";

export interface WorkspaceSummary {
  id: string;
  name: string;
  kind: "repository" | "directory" | "worktree";
  path: string;
  branch?: string;
  remote?: string;
}

export function WorkspaceContextBar({ workspaces, current, disabled, onRefresh, onSelected, onError }: {
  workspaces: WorkspaceSummary[];
  current: WorkspaceSummary | undefined;
  disabled: boolean;
  onRefresh: () => Promise<void>;
  onSelected: (workspace: WorkspaceSummary) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("");
  const [conflict, setConflict] = useState<{ currentUrl: string; requestedUrl: string }>();
  const [busy, setBusy] = useState("");
  const visible = useMemo(() => workspaces.filter((item) => `${item.name} ${item.path} ${item.remote ?? ""}`.toLowerCase().includes(filter.toLowerCase())), [filter, workspaces]);

  async function command(key: string, action: () => Promise<void>) {
    setBusy(key);
    try { await action(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  }

  async function select(workspace: WorkspaceSummary) {
    await command(`select:${workspace.id}`, async () => {
      const selected = await requestJson<WorkspaceSummary>(`/api/workspaces/${encodeURIComponent(workspace.id)}/select`, { method: "POST", body: JSON.stringify({ conversationId: "web:local-owner" }) });
      onSelected(selected);
      setRemote(selected.remote ?? "");
      setOpen(false);
    });
  }

  async function register() {
    if (!path.trim()) return;
    await command("register", async () => {
      const result = await requestJson<{ workspace: WorkspaceSummary }>("/api/workspaces", { method: "POST", body: JSON.stringify({ path, ...(name.trim() ? { name: name.trim() } : {}) }) });
      await onRefresh();
      await select(result.workspace);
      setPath(""); setName("");
    });
  }

  async function pickDirectory() {
    await command("pick", async () => {
      const result = await requestJson<{ path?: string; cancelled?: true }>("/api/workspaces/pick-directory", { method: "POST", body: "{}" });
      if (result.path) setPath(result.path);
    });
  }

  async function saveRemote(overwrite = false) {
    if (!current) return;
    await command("remote", async () => {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(current.id)}/remote`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: remote, overwrite }) });
      const result = await response.json() as { status?: string; currentUrl?: string; requestedUrl?: string; workspace?: WorkspaceSummary; error?: string };
      if (response.status === 409 && result.currentUrl && result.requestedUrl) { setConflict({ currentUrl: result.currentUrl, requestedUrl: result.requestedUrl }); return; }
      if (!response.ok) throw new Error(result.error ?? `remote 保存失败 (${response.status})`);
      setConflict(undefined);
      if (result.workspace) onSelected(result.workspace);
      await onRefresh();
    });
  }

  async function remove(workspace: WorkspaceSummary) {
    await command(`remove:${workspace.id}`, async () => {
      await requestJson(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
      await onRefresh();
      if (current?.id === workspace.id) {
        const fallback = workspaces.find((item) => item.id === "repository");
        if (fallback) await select(fallback);
      }
    });
  }

  const contextLabel = current?.branch ?? (current?.kind === "directory" ? "普通文件夹" : "未识别分支");
  const contextTitle = current ? `${current.name} · ${contextLabel}\n${current.path}${current.remote ? `\n${current.remote}` : ""}` : "Workspace 正在读取";

  return <div className="workspace-context">
    <button type="button" className="workspace-context-summary compact" title={contextTitle} disabled={disabled || !current} onClick={() => { setRemote(current?.remote ?? ""); setOpen((value) => !value); }} aria-expanded={open}>
      <span>Workspace:</span><b>{current?.name ?? "正在读取…"}</b><em>· {contextLabel}</em><i>▾</i>
    </button>
    {open && <div className="workspace-menu" role="dialog" aria-label="切换和管理 Workspace">
      <header><div><small>CONVERSATION CONTEXT</small><h3>选择 Workspace</h3></div><button type="button" aria-label="关闭 Workspace 选择器" onClick={() => setOpen(false)}>×</button></header>
      <input aria-label="搜索 Workspace" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索名称、路径或 remote…"/>
      <div className="workspace-list">{visible.map((workspace) => <div className={workspace.id === current?.id ? "active" : ""} key={workspace.id}><button type="button" onClick={() => void select(workspace)}><b>{workspace.name}</b><small>{workspace.path}</small><em>{workspace.branch ?? workspace.kind} · {workspace.remote ?? "no remote"}</em></button>{workspace.id !== "repository" && workspace.kind !== "worktree" && <button type="button" className="workspace-remove" aria-label={`移除 ${workspace.name}`} onClick={() => void remove(workspace)}>移除</button>}</div>)}</div>
      {current && <section className="workspace-remote"><label>当前 Workspace 的 origin<input disabled={current.kind !== "repository"} value={remote} onChange={(event) => setRemote(event.target.value)} placeholder={current.kind === "repository" ? "git@github.com:owner/repo.git" : "普通文件夹不能配置 remote"}/></label><button type="button" disabled={current.kind !== "repository" || !remote.trim() || busy === "remote"} onClick={() => void saveRemote()}>{busy === "remote" ? "保存中…" : "保存 remote"}</button>{conflict && <div className="remote-conflict"><b>已有不同的 origin</b><code>{conflict.currentUrl}</code><span>将更新为</span><code>{conflict.requestedUrl}</code><button type="button" onClick={() => void saveRemote(true)}>确认覆盖</button></div>}</section>}
      <section className="workspace-register"><h4>添加本地文件夹</h4><div><input aria-label="本地文件夹路径" value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void register(); } }} placeholder="/path/to/project"/><button type="button" disabled={busy === "pick"} onClick={() => void pickDirectory()}>{busy === "pick" ? "等待选择…" : "选择文件夹"}</button></div><input aria-label="Workspace 显示名称" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void register(); } }} placeholder="显示名称（可选）"/><button type="button" disabled={busy === "register" || !path.trim()} onClick={() => void register()}>{busy === "register" ? "添加中…" : "添加并切换"}</button></section>
    </div>}
  </div>;
}

async function requestJson<T = unknown>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const payload = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error ?? payload.message ?? `请求失败 (${response.status})`);
  return payload;
}
