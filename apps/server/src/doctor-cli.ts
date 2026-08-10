import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { loadConfig } from "./config.js";

interface Check { name: string; ok: boolean; detail: string; optional?: boolean }

dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });

const checks: Check[] = [];
try {
  const config = loadConfig();
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({ name: "Node.js", ok: Boolean(major && (major > 22 || major === 22 && (minor ?? 0) >= 5)), detail: `v${process.versions.node} (需要 >=22.5)` });

  const claude = spawnSync(config.claudeBin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  checks.push({ name: "Claude Code", ok: claude.status === 0, detail: claude.status === 0 ? claude.stdout.trim() : claude.error?.message ?? claude.stderr.trim() });

  const repositoryExists = existsSync(config.repositoryPath);
  let repositoryDetail = config.repositoryPath;
  let repositoryOk = false;
  if (repositoryExists) {
    const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: config.repositoryPath, encoding: "utf8" });
    repositoryOk = git.status === 0 && realpathSync(git.stdout.trim()) === realpathSync(config.repositoryPath);
    repositoryDetail = repositoryOk ? `${config.repositoryPath} (Git root)` : `${config.repositoryPath} (必须是 Git 根目录)`;
  }
  checks.push({ name: "目标仓库", ok: repositoryOk, detail: repositoryDetail });

  const executable = config.testCommandArgv[0]!;
  const command = spawnSync("which", [executable], { encoding: "utf8" });
  checks.push({ name: "测试命令", ok: command.status === 0, detail: config.testCommandArgv.join(" ") });

  let writableParent = config.dataDir;
  while (!existsSync(writableParent) && dirname(writableParent) !== writableParent) writableParent = dirname(writableParent);
  let writable = true;
  try { accessSync(writableParent, constants.W_OK); } catch { writable = false; }
  checks.push({ name: "数据目录", ok: writable, detail: config.dataDir });

  checks.push({
    name: "钉钉 Stream",
    ok: Boolean(config.dingtalk),
    optional: true,
    detail: config.dingtalk ? `已配置，允许 ${config.dingtalk.allowedUserIds.length} 个用户` : "未配置；Web demo 仍可运行",
  });
} catch (error) {
  checks.push({ name: "配置", ok: false, detail: error instanceof Error ? error.message : String(error) });
}

for (const check of checks) {
  const badge = check.ok ? "✓" : check.optional ? "○" : "✗";
  console.log(`${badge} ${check.name.padEnd(14)} ${check.detail}`);
}
const failed = checks.some((check) => !check.ok && !check.optional);
console.log(failed ? "\nDoctor 发现阻塞项。" : "\nDoctor 通过，可以启动 Mycel。 DINGTALK 未配置时仅启用 Web 通道。" );
process.exitCode = failed ? 1 : 0;
