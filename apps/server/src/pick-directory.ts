import { runCommand } from "@mycel/executor-claude-code";

export async function pickLocalDirectory(platform: NodeJS.Platform = process.platform): Promise<{ path: string } | { cancelled: true }> {
  const command = directoryPickerCommand(platform);
  if (!command) throw new Error("native folder picker is not available on this platform; enter an absolute path instead");
  const result = await runCommand(command.executable, command.args, { cwd: process.cwd(), timeoutMs: 5 * 60_000 });
  const output = result.stdout.trim();
  if (result.exitCode !== 0 || !output) {
    const detail = (result.stderr || result.stdout).trim();
    if (/cancel|canceled|cancelled|-128/i.test(detail) || result.exitCode === 1) return { cancelled: true };
    throw new Error(`folder picker failed: ${detail.slice(0, 300) || `exit ${result.exitCode}`}`);
  }
  return { path: output.replace(/[\r\n]+$/g, "") };
}

function directoryPickerCommand(platform: NodeJS.Platform): { executable: string; args: string[] } | undefined {
  if (platform === "darwin") return { executable: "osascript", args: ["-e", "POSIX path of (choose folder with prompt \"选择要添加到 Mycel 的 Workspace\")"] };
  if (platform === "win32") return {
    executable: "powershell.exe",
    args: ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){[Console]::Write($d.SelectedPath)}else{exit 1}"],
  };
  return { executable: "zenity", args: ["--file-selection", "--directory", "--title=选择要添加到 Mycel 的 Workspace"] };
}
