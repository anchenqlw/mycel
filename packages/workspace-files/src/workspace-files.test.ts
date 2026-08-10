import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceFilesService } from "./workspace-files.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mycel-files-"));
  directories.push(root);
  const repositoryPath = join(root, "repository");
  const dataDir = join(root, "data");
  mkdirSync(repositoryPath);
  mkdirSync(dataDir);
  return { root, repositoryPath, dataDir, service: new WorkspaceFilesService({ repositoryPath, dataDir }) };
}

describe("WorkspaceFilesService", () => {
  it("lists files and previews only the supported local text formats", async () => {
    const { repositoryPath, service } = fixture();
    writeFileSync(join(repositoryPath, "README.md"), "# Mycel\n\nLiving graph");
    writeFileSync(join(repositoryPath, "settings.json"), '{"enabled":true}');
    writeFileSync(join(repositoryPath, "archive.bin"), Buffer.from([0, 1, 2, 3]));

    const entries = await service.list("repository");
    expect(entries.map((entry) => entry.name)).toEqual(["archive.bin", "README.md", "settings.json"]);
    expect((await service.preview("repository", "README.md")).kind).toBe("markdown");
    expect((await service.preview("repository", "settings.json")).content).toContain('\n  "enabled": true\n');
    await expect(service.preview("repository", "archive.bin")).rejects.toThrow("not supported");
  });

  it("rejects traversal and symlinks that escape a registered workspace", async () => {
    const { root, repositoryPath, service } = fixture();
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "outside");
    symlinkSync(secret, join(repositoryPath, "escape.txt"));

    await expect(service.preview("repository", "../secret.txt")).rejects.toThrow("escapes");
    await expect(service.preview("repository", "escape.txt")).rejects.toThrow("escapes");
  });
});

describe("WorkspaceRegistry", () => {
  it("registers multiple real directories, persists selection, and deduplicates symlink aliases", async () => {
    const { root, repositoryPath, dataDir } = fixture();
    const second = join(root, "second");
    const alias = join(root, "second-alias");
    mkdirSync(second);
    symlinkSync(second, alias);
    const registry = new WorkspaceRegistry({ defaultPath: repositoryPath, dataDir });

    const created = await registry.register({ path: second, name: "Second Workspace" });
    const duplicate = await registry.register({ path: alias });
    expect(created.created).toBe(true);
    expect(duplicate).toMatchObject({ created: false, workspace: { id: created.workspace.id } });
    await registry.select("web:owner", created.workspace.id);

    const reloaded = new WorkspaceRegistry({ defaultPath: repositoryPath, dataDir });
    expect((await reloaded.selected("web:owner")).id).toBe(created.workspace.id);
    expect(await reloaded.list()).toHaveLength(2);
  });

  it("configures a real origin with conflict protection and never initializes plain folders", async () => {
    const { root, repositoryPath, dataDir } = fixture();
    execFileSync("git", ["init", "-b", "main"], { cwd: repositoryPath });
    const plain = join(root, "plain");
    mkdirSync(plain);
    const registry = new WorkspaceRegistry({ defaultPath: repositoryPath, dataDir });

    expect(await registry.configureOrigin("repository", "https://example.com/one.git")).toMatchObject({ status: "updated" });
    expect(await registry.configureOrigin("repository", "https://example.com/one.git")).toMatchObject({ status: "unchanged" });
    expect(await registry.configureOrigin("repository", "https://example.com/two.git")).toEqual({ status: "conflict", workspaceId: "repository", currentUrl: "https://example.com/one.git", requestedUrl: "https://example.com/two.git" });
    expect(await registry.configureOrigin("repository", "https://example.com/two.git", true)).toMatchObject({ status: "updated", workspace: { remote: "https://example.com/two.git" } });

    const plainWorkspace = await registry.register({ path: plain });
    await expect(registry.configureOrigin(plainWorkspace.workspace.id, "https://example.com/plain.git")).rejects.toThrow("Git repository");
    expect(() => execFileSync("git", ["rev-parse", "--git-dir"], { cwd: plain, stdio: "ignore" })).toThrow();
  });

  it("removes only registry state and protects the default workspace", async () => {
    const { root, repositoryPath, dataDir } = fixture();
    const extra = join(root, "extra");
    mkdirSync(extra);
    const registry = new WorkspaceRegistry({ defaultPath: repositoryPath, dataDir });
    const registered = await registry.register({ path: extra });
    await registry.remove(registered.workspace.id);
    expect((await registry.list()).map((item) => item.id)).toEqual(["repository"]);
    expect(() => writeFileSync(join(extra, "still-here"), "yes")).not.toThrow();
    await expect(registry.remove("repository")).rejects.toThrow("cannot be removed");
  });
});
