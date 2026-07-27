import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "bin", "vite-retain-assets.js");

const run = (...argumentsList) => spawnSync(
  process.execPath,
  [cli, ...argumentsList],
  { encoding: "utf8" },
);

test("prints CLI help without touching a build directory", () => {
  const result = run("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage:/);
  assert.equal(result.stderr, "");
});

test("rejects unknown CLI options", () => {
  const result = run("--delete-all");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option: --delete-all/);
  assert.match(result.stderr, /--dry-run/);
});

test("rejects a missing CLI option value", () => {
  const result = run("--dist", "--dry-run");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--dist requires a value/);
});

test("previews and applies retention for a custom Vite layout", async (t) => {
  const dist = await fs.mkdtemp(path.join(os.tmpdir(), "vite-retain-cli-"));
  t.after(() => fs.rm(dist, { recursive: true, force: true }));
  await fs.mkdir(path.join(dist, "build"), { recursive: true });
  await fs.mkdir(path.join(dist, "static"), { recursive: true });
  await fs.writeFile(
    path.join(dist, "build", "manifest.json"),
    JSON.stringify({ entry: { file: "static/current-12345678.js" } }),
  );
  await fs.writeFile(
    path.join(dist, "static", "current-12345678.js"),
    "current",
  );
  const expired = path.join(dist, "static", "expired-12345678.js");
  await fs.writeFile(expired, "old");
  await fs.utimes(expired, new Date(0), new Date(0));
  const argumentsList = [
    "--manifest",
    "build/manifest.json",
    "--assets-dir",
    "static",
    "--assets-base",
    "static",
    "--history-dir",
    ".history",
    "--dist",
    dist,
    "--history-limit",
    "2",
    "--grace-hours",
    "0",
  ];

  const preview = run(...argumentsList, "--dry-run");
  assert.equal(preview.status, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout), {
    distDirectory: dist,
    currentAssetCount: 1,
    retainedHistoryCount: 1,
    removable: ["static/expired-12345678.js"],
    dryRun: true,
  });
  await fs.stat(expired);
  await assert.rejects(fs.stat(path.join(dist, ".history")));

  const applied = run(...argumentsList);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).dryRun, false);
  await assert.rejects(fs.stat(expired));
  assert.equal((await fs.readdir(path.join(dist, ".history"))).length, 1);
});

test("rejects invalid numeric CLI values", () => {
  const invalidLimit = run("--history-limit", "many");
  assert.equal(invalidLimit.status, 1);
  assert.match(invalidLimit.stderr, /historyLimit/);

  const invalidGrace = run("--grace-hours", "-1");
  assert.equal(invalidGrace.status, 1);
  assert.match(invalidGrace.stderr, /gracePeriodMs/);
});
