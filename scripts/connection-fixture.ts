import { createServer } from "node:http";

const port = Number(process.env.MYCEL_FIXTURE_PORT ?? 57902);
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/.well-known/agent-card.json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      name: "Mycel E2E Planner",
      url: `http://127.0.0.1:${port}`,
      version: "1.0.0",
      capabilities: { streaming: true, pushNotifications: false },
      skills: [
        { id: "planning", name: "Production Planning", description: "Build a bounded production plan" },
        { id: "review", name: "Evidence Review", description: "Review evidence before handoff" },
      ],
    }));
    return;
  }
  if (request.method === "POST" && request.url === "/mcp") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const rpc = JSON.parse(body) as { id?: number; method?: string };
      if (rpc.method === "notifications/initialized") {
        response.writeHead(202, { "mcp-session-id": "mycel-e2e-session" });
        response.end();
        return;
      }
      const result = rpc.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "Mycel E2E MCP", version: "1.0.0" } }
        : rpc.method === "tools/list"
          ? { tools: [{ name: "research", description: "Research a bounded topic", inputSchema: { type: "object" } }] }
          : rpc.method === "resources/list"
            ? { resources: [{ name: "handbook", uri: "memory://handbook" }] }
            : rpc.method === "prompts/list"
              ? { prompts: [{ name: "evidence-review" }] }
              : {};
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "mycel-e2e-session" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mycel connection fixture listening on http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
