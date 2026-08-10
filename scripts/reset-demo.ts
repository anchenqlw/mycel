import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { runChecked } from "@mycel/executor-claude-code";

const projectRoot = resolve(import.meta.dirname, "..");
const source = resolve(projectRoot, "examples/target-repo");
const target = resolve(projectRoot, ".local/demo-repo");
const runtimeData = resolve(projectRoot, ".local/mycel");
const defaultSafeRoot = resolve(projectRoot, ".local");

export interface DemoResetPaths {
  dataDir: string;
  repositoryPath: string;
}

export async function resetDemoData(paths: DemoResetPaths, safeRoot: string): Promise<void> {
  const resolvedSafeRoot = resolve(safeRoot);
  if (lstatSync(resolvedSafeRoot).isSymbolicLink()) {
    throw new Error(`refusing to reset an unsafe target: ${resolvedSafeRoot}`);
  }
  const canonicalSafeRoot = realpathSync(resolvedSafeRoot);
  const dataDir = assertSafeResetTarget(paths.dataDir, resolvedSafeRoot, canonicalSafeRoot);
  const repositoryPath = assertSafeResetTarget(paths.repositoryPath, resolvedSafeRoot, canonicalSafeRoot);

  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repositoryPath, { recursive: true, force: true });
  mkdirSync(repositoryPath, { recursive: true });
  cpSync(source, repositoryPath, { recursive: true });
  await runChecked("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
  await runChecked("git", ["config", "user.name", "Mycel Demo"], { cwd: repositoryPath });
  await runChecked("git", ["config", "user.email", "mycel-demo@example.invalid"], { cwd: repositoryPath });
  await runChecked("git", ["add", "."], { cwd: repositoryPath });
  await runChecked("git", ["commit", "-m", "fixture: initial failing CSV exporter"], { cwd: repositoryPath });
}

function assertSafeResetTarget(targetPath: string, safeRoot: string, canonicalSafeRoot: string): string {
  const resolvedTarget = resolve(targetPath);
  const relativeTarget = relative(safeRoot, resolvedTarget);
  if (!isContainedRelativePath(relativeTarget)) {
    throw new Error(`refusing to reset an unsafe target: ${resolvedTarget}`);
  }
  let existingPath = safeRoot;
  for (const component of relativeTarget.split(sep)) {
    existingPath = join(existingPath, component);
    if (!existsSync(existingPath)) break;
    const canonicalExistingPath = realpathSync(existingPath);
    if (!isContainedRelativePath(relative(canonicalSafeRoot, canonicalExistingPath), true)) {
      throw new Error(`refusing to reset an unsafe target: ${resolvedTarget}`);
    }
  }
  return resolvedTarget;
}

function isContainedRelativePath(value: string, allowRoot = false): boolean {
  return (allowRoot || value.length > 0)
    && value !== ".."
    && !value.startsWith(`..${sep}`)
    && !isAbsolute(value);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await resetDemoData({ dataDir: runtimeData, repositoryPath: target }, defaultSafeRoot);
  console.log(`Demo repository: ${target}`);
  console.log(`Runtime ledger reset: ${runtimeData}`);
}
