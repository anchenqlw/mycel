import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegatingNotifier, type ApplicationService } from "@mycel/application";
import { DingTalkIntegration } from "@mycel/channel-dingtalk";
import type { AgentProfile } from "@mycel/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlPlaneService } from "./control-plane.js";
import {
  ConnectionManager,
  FakeFeishuProvisioner,
  LocalSecretStore,
} from "./connections.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("LocalSecretStore", () => {
  it("writes credentials atomically with owner-only permissions", () => {
    const directory = temporaryDirectory();
    const store = new LocalSecretStore(directory);
    store.write({ version: 1, dingtalk: { clientId: "ding-test", clientSecret: "top-secret", allowedUserIds: [] } });

    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "secrets")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(store.path, "utf8"))).toMatchObject({ dingtalk: { clientSecret: "top-secret" } });
  });
});

describe("ConnectionManager", () => {
  it("does not contain the OpenClaw robot registration contract", () => {
    const source = readFileSync(new URL("./connections.ts", import.meta.url), "utf8");
    expect(source).not.toContain("DING_DWS_CLAW");
    expect(source).not.toContain("/app/registration/");
  });

  it("persists a DingTalk application only after the connection succeeds", async () => {
    const directory = temporaryDirectory();
    const manager = new ConnectionManager(fakeApplication(), fakeControl(), new DelegatingNotifier(), { dataDir: directory, fakeConnections: true });

    const connected = await manager.configureDingTalkManually({ clientId: "ding-demo-client", clientSecret: "demo-secret-never-exposed", allowedUserIds: [] });

    expect(connected.phase).toBe("connected");
    const publicJson = JSON.stringify(manager.snapshot());
    expect(publicJson).not.toContain("demo-secret-never-exposed");
    expect(publicJson).not.toContain('"qr"');
    expect(readFileSync(join(directory, "secrets", "connections.json"), "utf8")).toContain("demo-secret-never-exposed");
  });

  it("keeps the previous DingTalk application and runtime when replacement validation fails", async () => {
    const directory = temporaryDirectory();
    new LocalSecretStore(directory).write({ version: 1, dingtalk: { clientId: "ding-working", clientSecret: "working-secret", allowedUserIds: ["owner-1"] } });
    vi.spyOn(DingTalkIntegration.prototype, "start")
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("invalid client credentials"));
    const stop = vi.spyOn(DingTalkIntegration.prototype, "stop");
    const manager = new ConnectionManager(fakeApplication(), fakeControl(), new DelegatingNotifier(), { dataDir: directory });
    await manager.initialize();

    await expect(manager.configureDingTalkManually({ clientId: "ding-broken", clientSecret: "broken-secret", allowedUserIds: [] }))
      .rejects.toThrow("invalid client credentials");

    expect(manager.snapshot().im.dingtalk).toMatchObject({ phase: "connected", clientIdHint: "ding…king" });
    expect(manager.snapshot().im.dingtalk.message).toContain("已保留原连接");
    expect(new LocalSecretStore(directory).read().dingtalk).toMatchObject({ clientId: "ding-working", clientSecret: "working-secret" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("completes the Feishu QR flow and keeps the app secret private", async () => {
    const directory = temporaryDirectory();
    const manager = new ConnectionManager(
      fakeApplication(),
      fakeControl(),
      new DelegatingNotifier(),
      { dataDir: directory, fakeConnections: true },
      new FakeFeishuProvisioner(),
    );

    const waiting = await manager.beginFeishuQr();
    expect(waiting).toMatchObject({ phase: "waiting-for-scan", messageMode: "markdown" });
    expect(waiting.qr?.imageDataUrl).toMatch(/^data:image\/png;base64,/);

    await waitUntil(() => manager.snapshot().im.feishu.phase === "connected");
    expect(JSON.stringify(manager.snapshot())).not.toContain("feishu-secret-never-exposed");
    expect(readFileSync(join(directory, "secrets", "connections.json"), "utf8")).toContain("feishu-secret-never-exposed");
  });

  it("validates an A2A Agent Card before allowing adoption", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      name: "Remote Planner",
      capabilities: { streaming: true },
      skills: [{ id: "plan", name: "Planning" }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const adopted: AgentProfile[] = [];
    const control = fakeControl({
      adoptExternalAgent: (input) => {
        const profile: AgentProfile = {
          id: "agent:external:remote-planner",
          name: input.name,
          source: "adopted",
          adapterKind: input.adapterKind,
          status: "online",
          capabilities: input.capabilities,
          contractLevel: input.contractLevel,
          connectionUri: input.connectionUri,
          lifecycle: "persistent",
          registeredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        adopted.push(profile);
        return profile;
      },
    });
    const manager = new ConnectionManager(fakeApplication(), control, new DelegatingNotifier(), { dataDir: temporaryDirectory() });
    const discovery = await manager.discoverExternalAgent({ protocol: "a2a", endpoint: "http://127.0.0.1:4318" });
    expect(discovery.status).toBe("ready");
    expect(discovery.capabilities).toContain("skill:Planning");

    const profile = manager.adoptExternalAgent(discovery.id);
    expect(profile.name).toBe("Remote Planner");
    expect(adopted).toHaveLength(1);
    expect(manager.snapshot().externalDiscoveries[0]?.status).toBe("adopted");
  });

  it("completes the MCP lifecycle before exposing discovered capabilities", async () => {
    const calls: Array<{ method: string; sessionId?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method: string };
      const headers = new Headers(init?.headers);
      calls.push({ method: rpc.method, ...(headers.get("mcp-session-id") ? { sessionId: headers.get("mcp-session-id")! } : {}) });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = rpc.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Remote MCP" } }
        : rpc.method === "tools/list"
          ? { tools: [{ name: "research" }] }
          : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }), {
        status: 200,
        headers: { "content-type": "application/json", ...(rpc.method === "initialize" ? { "mcp-session-id": "session-1" } : {}) },
      });
    }));
    const manager = new ConnectionManager(fakeApplication(), fakeControl(), new DelegatingNotifier(), { dataDir: temporaryDirectory() });

    const discovery = await manager.discoverExternalAgent({ protocol: "mcp", endpoint: "http://127.0.0.1:4318/mcp" });

    expect(discovery).toMatchObject({ status: "ready", name: "Remote MCP" });
    expect(discovery.capabilities).toContain("tool:research");
    expect(calls.slice(0, 3)).toEqual([
      { method: "initialize" },
      { method: "notifications/initialized", sessionId: "session-1" },
      { method: "tools/list", sessionId: "session-1" },
    ]);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mycel-connections-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeApplication(): ApplicationService {
  return { getProjection: () => ({ agents: {} }) } as unknown as ApplicationService;
}

function fakeControl(overrides: Partial<ControlPlaneService> = {}): ControlPlaneService {
  return {
    discoverLocalAgents: async () => [],
    adoptLocalAgent: () => { throw new Error("not used"); },
    adoptExternalAgent: () => { throw new Error("not used"); },
    approveProductionProposal: async () => ({}),
    rejectProductionProposal: () => ({}),
    ...overrides,
  } as unknown as ControlPlaneService;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not reached before timeout");
}
