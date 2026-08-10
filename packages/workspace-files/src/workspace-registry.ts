import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { runCommand } from "@mycel/executor-claude-code";

export interface RegisteredWorkspace {
  id: string;
  name: string;
  path: string;
  realPath: string;
  kind: "repository" | "directory";
  branch?: string;
  remote?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

export interface WorkspaceRemoteConflict {
  status: "conflict";
  workspaceId: string;
  currentUrl: string;
  requestedUrl: string;
}

export interface WorkspaceRemoteUpdated {
  status: "updated" | "unchanged";
  workspace: RegisteredWorkspace;
}

interface RegistryRecord {
  version: 1;
  workspaces: Array<Pick<RegisteredWorkspace, "id" | "name" | "path" | "realPath" | "createdAt" | "updatedAt" | "lastUsedAt">>;
  bindings: Record<string, string>;
}

export class WorkspaceRegistry {
  readonly #dataDir: string;
  readonly #filePath: string;
  readonly #defaultPath: string;
  #record: RegistryRecord | undefined;
  #loading: Promise<void> | undefined;

  constructor(input: { dataDir: string; defaultPath: string }) {
    this.#dataDir = resolve(input.dataDir);
    this.#filePath = join(this.#dataDir, "workspaces.json");
    this.#defaultPath = resolve(input.defaultPath);
  }

  async list(): Promise<RegisteredWorkspace[]> {
    await this.#load();
    return Promise.all(this.#record!.workspaces.map((item) => this.#describe(item)));
  }

  async get(workspaceId: string): Promise<RegisteredWorkspace> {
    const item = (await this.list()).find((candidate) => candidate.id === workspaceId);
    if (!item) throw new Error(`workspace is not registered: ${workspaceId}`);
    return item;
  }

  async register(input: { path: string; name?: string }): Promise<{ workspace: RegisteredWorkspace; created: boolean }> {
    await this.#load();
    const realPath = await validateDirectory(input.path);
    const existing = this.#record!.workspaces.find((item) => item.realPath === realPath);
    if (existing) return { workspace: await this.#describe(existing), created: false };
    const now = new Date().toISOString();
    const item: RegistryRecord["workspaces"][number] = {
      id: `workspace:${randomUUID()}`,
      name: cleanName(input.name) ?? basename(realPath),
      path: resolve(input.path),
      realPath,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
    this.#record!.workspaces.push(item);
    await this.#save();
    return { workspace: await this.#describe(item), created: true };
  }

  async rename(workspaceId: string, name: string): Promise<RegisteredWorkspace> {
    await this.#load();
    const item = this.#requiredRecord(workspaceId);
    item.name = cleanName(name) ?? basename(item.realPath);
    item.updatedAt = new Date().toISOString();
    await this.#save();
    return this.#describe(item);
  }

  async remove(workspaceId: string): Promise<{ removed: true }> {
    await this.#load();
    if (workspaceId === "repository") throw new Error("the default repository workspace cannot be removed");
    const index = this.#record!.workspaces.findIndex((item) => item.id === workspaceId);
    if (index < 0) throw new Error(`workspace is not registered: ${workspaceId}`);
    this.#record!.workspaces.splice(index, 1);
    for (const [conversationId, selectedId] of Object.entries(this.#record!.bindings)) {
      if (selectedId === workspaceId) delete this.#record!.bindings[conversationId];
    }
    await this.#save();
    return { removed: true };
  }

  async select(conversationId: string, workspaceId: string): Promise<RegisteredWorkspace> {
    await this.#load();
    const item = this.#requiredRecord(workspaceId);
    await validateDirectory(item.realPath);
    const now = new Date().toISOString();
    item.lastUsedAt = now;
    item.updatedAt = now;
    this.#record!.bindings[conversationId] = workspaceId;
    await this.#save();
    return this.#describe(item);
  }

  async selected(conversationId: string): Promise<RegisteredWorkspace> {
    await this.#load();
    const workspaceId = this.#record!.bindings[conversationId] ?? "repository";
    try { return await this.get(workspaceId); }
    catch { return this.get("repository"); }
  }

  async configureOrigin(workspaceId: string, requestedUrl: string, overwrite = false): Promise<WorkspaceRemoteConflict | WorkspaceRemoteUpdated> {
    const workspace = await this.get(workspaceId);
    if (workspace.kind !== "repository") throw new Error("remote can only be configured for a Git repository");
    const url = validateRemoteUrl(requestedUrl);
    const currentUrl = workspace.remote;
    if (currentUrl === url) return { status: "unchanged", workspace };
    if (currentUrl && !overwrite) return { status: "conflict", workspaceId, currentUrl, requestedUrl: url };
    const args = currentUrl ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url];
    const result = await runCommand("git", args, { cwd: workspace.realPath, timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new Error(`unable to configure Git origin: ${sanitizeGitError(result.stderr || result.stdout)}`);
    const item = this.#requiredRecord(workspaceId);
    item.updatedAt = new Date().toISOString();
    await this.#save();
    return { status: "updated", workspace: await this.#describe(item) };
  }

  async #load(): Promise<void> {
    if (this.#record) return;
    if (this.#loading) return this.#loading;
    this.#loading = (async () => {
      await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
      const defaultRealPath = await validateDirectory(this.#defaultPath);
      try {
        const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as RegistryRecord;
        if (parsed.version !== 1 || !Array.isArray(parsed.workspaces) || typeof parsed.bindings !== "object") throw new Error("invalid workspace registry");
        this.#record = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const now = new Date().toISOString();
        this.#record = {
          version: 1,
          workspaces: [{ id: "repository", name: basename(defaultRealPath), path: this.#defaultPath, realPath: defaultRealPath, createdAt: now, updatedAt: now, lastUsedAt: now }],
          bindings: {},
        };
        await this.#save();
      }
      if (!this.#record.workspaces.some((item) => item.id === "repository")) {
        const now = new Date().toISOString();
        this.#record.workspaces.unshift({ id: "repository", name: basename(defaultRealPath), path: this.#defaultPath, realPath: defaultRealPath, createdAt: now, updatedAt: now, lastUsedAt: now });
        await this.#save();
      }
    })().finally(() => { this.#loading = undefined; });
    return this.#loading;
  }

  async #save(): Promise<void> {
    if (!this.#record) throw new Error("workspace registry is not initialized");
    await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.#record, null, 2), { mode: 0o600 });
    await rename(temporary, this.#filePath);
  }

  #requiredRecord(workspaceId: string): RegistryRecord["workspaces"][number] {
    const item = this.#record!.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!item) throw new Error(`workspace is not registered: ${workspaceId}`);
    return item;
  }

  async #describe(item: RegistryRecord["workspaces"][number]): Promise<RegisteredWorkspace> {
    const git = await inspectGit(item.realPath);
    return { ...item, kind: git.repository ? "repository" : "directory", ...(git.branch ? { branch: git.branch } : {}), ...(git.remote ? { remote: git.remote } : {}) };
  }
}

async function validateDirectory(inputPath: string): Promise<string> {
  if (!inputPath.trim() || !isAbsolute(inputPath)) throw new Error("workspace path must be an absolute path");
  const resolved = await realpath(resolve(inputPath));
  const details = await stat(resolved);
  if (!details.isDirectory()) throw new Error("workspace path must be a directory");
  await access(resolved, constants.R_OK);
  return resolved;
}

async function inspectGit(cwd: string): Promise<{ repository: boolean; branch?: string; remote?: string }> {
  const root = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  if (root.exitCode !== 0 || resolve(root.stdout.trim()) !== resolve(cwd)) return { repository: false };
  const [branch, remote] = await Promise.all([
    runCommand("git", ["branch", "--show-current"], { cwd, timeoutMs: 10_000 }),
    runCommand("git", ["remote", "get-url", "origin"], { cwd, timeoutMs: 10_000 }),
  ]);
  return {
    repository: true,
    ...(branch.exitCode === 0 && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
    ...(remote.exitCode === 0 && remote.stdout.trim() ? { remote: remote.stdout.trim() } : {}),
  };
}

function cleanName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 120) throw new Error("workspace name exceeds 120 characters");
  return normalized;
}

function validateRemoteUrl(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_000 || /[\0\r\n]/.test(normalized) || normalized.startsWith("-")) throw new Error("invalid Git remote URL");
  return normalized;
}

function sanitizeGitError(value: string): string {
  return value.trim().replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[credentials-hidden]@").slice(0, 500) || "Git returned a non-zero exit code";
}
