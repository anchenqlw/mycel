const REDACTED = "[redacted]";
const SENSITIVE_KEYS = new Set([
  "prompt", "systemprompt", "developerprompt", "instruction", "instructions",
  "raw", "rawevent", "rawevents", "rawtoolevent", "rawtoolevents", "rawcontent",
  "toolinput", "toolinputs", "toolarguments", "toolparameters", "input", "inputs",
  "command", "commands", "commandline", "shellcommand", "argv", "arg", "args", "argument", "arguments", "param", "params", "parameter", "parameters",
  "content", "contents", "filecontent", "filecontents", "filebody", "output", "stdout", "stderr",
  "auth", "authorization", "cookie", "cookies", "token", "accesstoken", "refreshtoken", "idtoken", "secret", "clientsecret", "appsecret", "password", "credential", "credentials", "privatekey",
]);

/** Build a UI-safe recursive projection of ledger/runtime payloads. */
export function sanitizeForPresentation(value: unknown): unknown {
  return sanitize(value, new WeakSet<object>(), 0);
}

function sanitize(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 20) return "[maximum depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    isSensitiveKey(key) ? REDACTED : sanitize(child, seen, depth + 1),
  ]));
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEYS.has(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password")
    || normalized.endsWith("credential")
    || normalized.endsWith("filecontent")
    || normalized.endsWith("toolinput")
    || normalized.endsWith("commandargs");
}

function sanitizeString(value: string): string {
  if (/agent is not registered\s*:\s*\S+/i.test(value)) return "Worker is not connected to a local execution adapter";
  if (/workspace is not registered\s*:\s*\S+/i.test(value)) return "Worker cannot access the selected Workspace";
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return REDACTED;
  if (/(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+\S+/i.test(value)) return REDACTED;
  if (/(?:cookie|set-cookie)\s*:\s*[^\s]+/i.test(value)) return REDACTED;
  if (/(?:^|\s)(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)\S+/i.test(value)) return REDACTED;
  return value;
}
