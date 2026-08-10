import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicDemoApplication, seedPublicDemo } from "./public-demo-fixture.js";
import { resetDemoData } from "./reset-demo.js";
import { WorkspaceFilesService } from "@mycel/workspace-files";

const projectRoot = resolve(import.meta.dirname, "..");
const publicDemoRoot = resolve(projectRoot, ".local/public-demo");
const repositoryPath = resolve(publicDemoRoot, "repository");
const runtimeData = resolve(publicDemoRoot, "runtime");

mkdirSync(publicDemoRoot, { recursive: true });
await resetDemoData({ dataDir: runtimeData, repositoryPath }, publicDemoRoot);
writeFileSync(resolve(repositoryPath, "release-review.demoasset"), "This is a fictional public demo asset for testing the system-application preview fallback.\n", "utf8");
const application = await createPublicDemoApplication(resolve(runtimeData, "ledger.sqlite"));
await seedPublicDemo(application, new Date().toISOString());
const files = new WorkspaceFilesService({ repositoryPath, dataDir: runtimeData });
await files.registry.list();
await files.registry.rename("repository", "Demo Workspace");

console.log("Public demo repository ready");
console.log("Public demo runtime ready");
