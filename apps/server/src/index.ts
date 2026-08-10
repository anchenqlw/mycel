import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { buildServer } from "./server.js";

export async function main(): Promise<void> {
  dotenv.config({ path: ".env.local", quiet: true });
  dotenv.config({ quiet: true });
  const config = loadConfig();
  const runtime = await createRuntime(config);
  const server = await buildServer(runtime);
  const stop = async () => {
    runtime.stop();
    await server.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await server.listen({ host: "127.0.0.1", port: config.port });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
