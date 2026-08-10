import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RenderedWorkerHarness } from "./worker-harness.js";

interface WorkerSecretDocument {
  version: 1;
  secrets: Record<string, string>;
}

export class WorkerSecretStore {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "secrets", "worker-secrets.json");
  }

  list(): string[] {
    return Object.keys(this.#read().secrets).sort();
  }

  has(secretRef: string): boolean {
    return Object.hasOwn(this.#read().secrets, secretRef);
  }

  set(secretRef: string, value: string): void {
    if (!secretRef.trim() || !value) throw new Error("SecretRef and value are required");
    const document = this.#read();
    document.secrets[secretRef] = value;
    this.#write(document);
  }

  delete(secretRef: string): boolean {
    const document = this.#read();
    if (!Object.hasOwn(document.secrets, secretRef)) return false;
    delete document.secrets[secretRef];
    this.#write(document);
    return true;
  }

  resolve(secretRef: string): string {
    const value = this.#read().secrets[secretRef];
    if (!value) throw new Error(`SecretRef is not configured: ${secretRef}`);
    return value;
  }

  #read(): WorkerSecretDocument {
    if (!existsSync(this.path)) return { version: 1, secrets: {} };
    const document = JSON.parse(readFileSync(this.path, "utf8")) as WorkerSecretDocument;
    if (document.version !== 1 || !document.secrets) throw new Error("unsupported Worker Secret Store version");
    return document;
  }

  #write(document: WorkerSecretDocument): void {
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

export function materializeMcpConfig(input: { dataDir: string; sessionId: string; harness: RenderedWorkerHarness; secrets: WorkerSecretStore }): { path?: string; cleanup(): void } {
  if (input.harness.mcpServers.length === 0) return { cleanup() {} };
  const directory = join(input.dataDir, "sessions", safeName(input.sessionId), "harness");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, "mcp.json");
  const mcpServers = Object.fromEntries(input.harness.mcpServers.map((server) => [server.name, {
    type: server.transport,
    ...(server.command ? { command: server.command } : {}), args: server.args,
    ...(server.url ? { url: server.url } : {}),
    env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, "secretRef" in value ? input.secrets.resolve(value.secretRef) : value.value])),
  }]));
  writeFileSync(path, JSON.stringify({ mcpServers }), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 160);
}
