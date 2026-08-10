import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["apps/server/src/index.ts"],
  outDir: "dist/server",
  format: ["esm"],
  platform: "node",
  target: "node22",
  removeNodeProtocol: false,
  sourcemap: true,
  clean: true,
  external: [
    "node:sqlite",
    "@alicloud/dingtalk",
    "@alicloud/openapi-client",
    "@alicloud/tea-util",
    "dingtalk-stream",
    "qrcode",
  ],
  noExternal: [/^@mycel\//],
});
