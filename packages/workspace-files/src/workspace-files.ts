import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runCommand } from "@mycel/executor-claude-code";
import { WorkspaceRegistry } from "./workspace-registry.js";

export interface WorkspaceDescriptor {
  id: string;
  name: string;
  kind: "repository" | "directory" | "worktree";
  path: string;
  branch?: string;
  remote?: string;
}

export interface FileTreeEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
  gitStatus?: string;
}

export interface FilePreview {
  workspaceId: string;
  path: string;
  name: string;
  kind: "code" | "text" | "markdown" | "json";
  language: string;
  content: string;
  size: number;
  modifiedAt: string;
}

export interface WorkspaceArtifact {
  workspaceId: string;
  path: string;
  absolutePath: string;
  name: string;
  size: number;
  sha256: string;
  mediaType: string;
}

const previewExtensions = new Set([
  ".c", ".cc", ".cpp", ".css", ".go", ".h", ".html", ".java", ".js", ".jsx", ".kt", ".md", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".svelte", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml", ".json",
]);

export class WorkspaceFilesService {
  readonly #repositoryPath: string;
  readonly #worktreesPath: string;
  readonly #maxPreviewBytes: number;
  readonly registry: WorkspaceRegistry;

  constructor(input: { repositoryPath: string; dataDir: string; maxPreviewBytes?: number; registry?: WorkspaceRegistry }) {
    this.#repositoryPath = realpathSync(input.repositoryPath);
    this.#worktreesPath = resolve(input.dataDir, "worktrees");
    this.#maxPreviewBytes = input.maxPreviewBytes ?? 1_000_000;
    this.registry = input.registry ?? new WorkspaceRegistry({ defaultPath: input.repositoryPath, dataDir: input.dataDir });
  }

  async workspaces(): Promise<WorkspaceDescriptor[]> {
    const registered = await this.registry.list();
    const items: WorkspaceDescriptor[] = registered.map((workspace) => ({ id: workspace.id, name: workspace.name, kind: workspace.kind, path: workspace.realPath, ...(workspace.branch ? { branch: workspace.branch } : {}), ...(workspace.remote ? { remote: workspace.remote } : {}) }));
    try {
      const children = await readdir(this.#worktreesPath, { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory()) continue;
        const path = realpathSync(join(this.#worktreesPath, child.name));
        if (!isInside(path, this.#worktreesPath)) continue;
        items.push({ id: `worktree:${child.name}`, name: child.name, kind: "worktree", path });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return items;
  }

  async list(workspaceId: string, relativePath = ""): Promise<FileTreeEntry[]> {
    const root = await this.#root(workspaceId);
    const target = await safeExistingPath(root.path, relativePath);
    const targetStat = await stat(target);
    if (!targetStat.isDirectory()) throw new Error("file tree path is not a directory");
    const git = await gitStatuses(root.path);
    const children = await readdir(target, { withFileTypes: true });
    const entries = await Promise.all(children
      .filter((child) => child.name !== ".git")
      .map(async (child): Promise<FileTreeEntry> => {
        const childPath = await safeExistingPath(root.path, relativePath ? `${relativePath}/${child.name}` : child.name);
        const childStat = await stat(childPath);
        const path = relative(root.path, childPath).split(sep).join("/");
        const gitStatus = git.get(path);
        return {
          name: child.name,
          path,
          kind: child.isDirectory() ? "directory" : "file",
          size: childStat.size,
          modifiedAt: childStat.mtime.toISOString(),
          ...(gitStatus ? { gitStatus } : {}),
        };
      }));
    return entries.sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "directory" ? -1 : 1);
  }

  async preview(workspaceId: string, relativePath: string): Promise<FilePreview> {
    const root = await this.#root(workspaceId);
    const target = await safeExistingPath(root.path, relativePath);
    const targetStat = await stat(target);
    if (!targetStat.isFile()) throw new Error("preview path is not a file");
    if (targetStat.size > this.#maxPreviewBytes) throw new Error(`file exceeds preview limit of ${this.#maxPreviewBytes} bytes`);
    const extension = extname(target).toLowerCase();
    if (!previewExtensions.has(extension) && extension !== "") throw new Error("file type is not supported by the built-in preview");
    const bytes = await readFile(target);
    if (bytes.includes(0)) throw new Error("binary files must be opened with the system application");
    const content = bytes.toString("utf8");
    const kind = extension === ".md" ? "markdown" : extension === ".json" ? "json" : codeExtensions.has(extension) ? "code" : "text";
    let normalized = content;
    if (kind === "json") normalized = JSON.stringify(JSON.parse(content) as unknown, null, 2);
    return { workspaceId, path: relativePath, name: basename(target), kind, language: languageFor(extension), content: normalized, size: targetStat.size, modifiedAt: targetStat.mtime.toISOString() };
  }

  async openWithSystem(workspaceId: string, relativePath: string): Promise<{ opened: true; path: string }> {
    const root = await this.#root(workspaceId);
    const target = await safeExistingPath(root.path, relativePath);
    const [command, args] = systemOpenCommand(target);
    const child = spawn(command, args, { shell: false, detached: true, stdio: "ignore" });
    child.unref();
    return { opened: true, path: relativePath };
  }

  async artifact(workspaceId: string, relativePath: string): Promise<WorkspaceArtifact> {
    const root = await this.#root(workspaceId);
    const target = await safeExistingPath(root.path, relativePath);
    const targetStat = await stat(target);
    if (!targetStat.isFile()) throw new Error("artifact path is not a file");
    const bytes = await readFile(target);
    return {
      workspaceId,
      path: relativePath,
      absolutePath: target,
      name: basename(target),
      size: targetStat.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: mediaTypeFor(extname(target).toLowerCase()),
    };
  }

  async #root(workspaceId: string): Promise<WorkspaceDescriptor> {
    const workspace = (await this.workspaces()).find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`workspace is not registered: ${workspaceId}`);
    return workspace;
  }
}

const codeExtensions = new Set([".c", ".cc", ".cpp", ".css", ".go", ".h", ".html", ".java", ".js", ".jsx", ".kt", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".svelte", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml", ".toml"]);

async function safeExistingPath(root: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath)) throw new Error("absolute paths are not allowed");
  const candidate = resolve(root, relativePath || ".");
  const resolved = realpathSync(candidate);
  if (!isInside(resolved, root)) throw new Error("path escapes the registered workspace");
  return resolved;
}

function isInside(candidate: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${sep}`);
}

async function gitStatuses(root: string): Promise<Map<string, string>> {
  const result = await runCommand("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, timeoutMs: 10_000 });
  const statuses = new Map<string, string>();
  if (result.exitCode !== 0) return statuses;
  for (const record of result.stdout.split("\0")) {
    if (record.length < 4) continue;
    statuses.set(record.slice(3), record.slice(0, 2).trim() || "modified");
  }
  return statuses;
}

function languageFor(extension: string): string {
  return ({ ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".ts": "typescript", ".tsx": "typescript", ".py": "python", ".rs": "rust", ".go": "go", ".md": "markdown", ".json": "json", ".yml": "yaml", ".yaml": "yaml", ".sh": "shell", ".html": "html", ".css": "css" } as Record<string, string>)[extension] ?? "text";
}

function mediaTypeFor(extension: string): string {
  return ({
    ".json": "application/json",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".pdf": "application/pdf",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function systemOpenCommand(path: string): [string, string[]] {
  if (process.platform === "darwin") return ["open", [path]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", path]];
  return ["xdg-open", [path]];
}
