import assert from "node:assert/strict";
import test from "node:test";
import { exportCsv } from "../src/export.js";

test("exports UTF-8 CSV with a BOM for spreadsheet compatibility", () => {
  const csv = exportCsv([{ name: "陈默", city: "杭州" }]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /陈默,杭州/);
});
