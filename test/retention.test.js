import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  collectManifestAssets,
  retainBuildAssets,
} from "../src/index.js";

const temporaryDirectories = [];
const makeTemporaryDirectory = async (prefix) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

after(async () => {
  await Promise.all(temporaryDirectories.map(
    (directory) => fs.rm(directory, { recursive: true, force: true }),
  ));
});

test("collects JavaScript, CSS, and emitted assets from a Vite manifest", () => {
  const assets = collectManifestAssets({
    entry: {
      file: "assets/main-12345678.js",
      css: ["assets/main-12345678.css"],
      assets: ["assets/logo.svg"],
    },
  });
  assert.deepEqual([...assets].sort(), [
    "assets/logo.svg",
    "assets/main-12345678.css",
    "assets/main-12345678.js",
  ]);
});

test("retains current and recent build generations", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-");
  const assets = path.join(root, "assets");
  const history = path.join(root, ".asset-history");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.mkdir(assets, { recursive: true });
  await fs.mkdir(history, { recursive: true });
  await fs.writeFile(
    path.join(root, ".vite", "manifest.json"),
    JSON.stringify({ entry: { file: "assets/current-12345678.js" } }),
  );
  await fs.writeFile(
    path.join(history, "0000000000001000.json"),
    JSON.stringify({ assets: ["assets/previous-12345678.js"] }),
  );
  for (const name of [
    "current-12345678.js",
    "previous-12345678.js",
    "expired-12345678.js",
  ]) {
    const file = path.join(assets, name);
    await fs.writeFile(file, name);
    await fs.utimes(file, new Date(0), new Date(0));
  }

  const result = await retainBuildAssets({
    distDirectory: root,
    nowMs: 2_000,
    historyLimit: 2,
    gracePeriodMs: 0,
  });
  assert.deepEqual(result.removable, ["assets/expired-12345678.js"]);
  await assert.rejects(fs.stat(path.join(assets, "expired-12345678.js")));
  await fs.stat(path.join(assets, "previous-12345678.js"));
});

test("dry-run performs no writes or deletions", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-dry-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".vite", "manifest.json"),
    JSON.stringify({ entry: { file: "assets/current-12345678.js" } }),
  );
  await fs.writeFile(
    path.join(root, "assets", "current-12345678.js"),
    "current",
  );
  const expired = path.join(root, "assets", "expired-12345678.js");
  await fs.writeFile(expired, "old");
  await fs.utimes(expired, new Date(0), new Date(0));

  const result = await retainBuildAssets({
    distDirectory: root,
    nowMs: 2_000,
    gracePeriodMs: 0,
    dryRun: true,
  });
  assert.deepEqual(result.removable, ["assets/expired-12345678.js"]);
  await fs.stat(expired);
  await assert.rejects(fs.stat(path.join(root, ".asset-history")));
});

test("rejects retention paths that escape the distribution root", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-root-");
  const outside = await makeTemporaryDirectory("vite-continuity-outside-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.writeFile(path.join(root, ".vite", "manifest.json"), "{}");

  await assert.rejects(
    retainBuildAssets({
      distDirectory: root,
      assetsDirectory: outside,
      dryRun: true,
    }),
    /assetsDirectory must stay within distDirectory/,
  );
});

test("rejects an asset directory symlink that resolves outside the root", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-link-");
  const outside = await makeTemporaryDirectory("vite-continuity-target-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.writeFile(path.join(root, ".vite", "manifest.json"), "{}");
  await fs.symlink(outside, path.join(root, "assets"), "dir");

  await assert.rejects(
    retainBuildAssets({
      distDirectory: root,
      dryRun: true,
    }),
    /assetsDirectory resolves outside distDirectory/,
  );
});

test("does not read or overwrite symbolic-link history files", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-history-");
  const outside = await makeTemporaryDirectory("vite-continuity-history-out-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.mkdir(path.join(root, ".asset-history"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".vite", "manifest.json"),
    JSON.stringify({ entry: { file: "assets/current-12345678.js" } }),
  );
  await fs.writeFile(
    path.join(root, "assets", "current-12345678.js"),
    "current",
  );
  const external = path.join(outside, "history.json");
  await fs.writeFile(external, '{"unchanged":true}\n');
  await fs.symlink(
    external,
    path.join(root, ".asset-history", "0000000000002000.json"),
  );

  await assert.rejects(
    retainBuildAssets({
      distDirectory: root,
      nowMs: 2_000,
      historyLimit: 2,
    }),
    /asset history must be a regular file/,
  );
  assert.equal(await fs.readFile(external, "utf8"), '{"unchanged":true}\n');
});

test("normalizes a trailing slash in the manifest asset base", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-base-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".vite", "manifest.json"),
    JSON.stringify({ entry: { file: "assets/current-12345678.js" } }),
  );
  await fs.writeFile(
    path.join(root, "assets", "current-12345678.js"),
    "current",
  );
  const expired = path.join(root, "assets", "expired-12345678.js");
  await fs.writeFile(expired, "old");
  await fs.utimes(expired, new Date(0), new Date(0));

  const result = await retainBuildAssets({
    distDirectory: root,
    assetsBase: "assets/",
    nowMs: 2_000,
    gracePeriodMs: 0,
  });

  assert.deepEqual(result.removable, ["assets/expired-12345678.js"]);
  await assert.rejects(fs.stat(expired));
});

test("rejects invalid retention windows", async () => {
  await assert.rejects(
    retainBuildAssets({ distDirectory: ".", dryrun: true }),
    /unknown retention option/,
  );
  await assert.rejects(
    retainBuildAssets({ distDirectory: ".", historyLimit: Number.NaN }),
    /historyLimit/,
  );
  await assert.rejects(
    retainBuildAssets({ distDirectory: ".", historyLimit: 1.5 }),
    /historyLimit/,
  );
  await assert.rejects(
    retainBuildAssets({ distDirectory: ".", gracePeriodMs: -1 }),
    /gracePeriodMs/,
  );
  await assert.rejects(
    retainBuildAssets({ distDirectory: ".", nowMs: -1 }),
    /Date range/,
  );
});

test("preserves a caller-owned regular expression state", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-regex-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".vite", "manifest.json"),
    JSON.stringify({ entry: { file: "assets/current-12345678.js" } }),
  );
  await fs.writeFile(
    path.join(root, "assets", "current-12345678.js"),
    "current",
  );
  await fs.writeFile(path.join(root, "assets", "old-12345678.js"), "old");
  const pattern = /-[A-Za-z0-9_-]{8,}\.js$/g;
  pattern.lastIndex = 7;

  await retainBuildAssets({
    distDirectory: root,
    assetPattern: pattern,
    dryRun: true,
    gracePeriodMs: 0,
  });

  assert.equal(pattern.lastIndex, 7);
});

test("rejects an empty manifest before changing history or assets", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-empty-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  const oldAsset = path.join(root, "assets", "old-12345678.js");
  await fs.writeFile(path.join(root, ".vite", "manifest.json"), "{}");
  await fs.writeFile(oldAsset, "old");

  await assert.rejects(
    retainBuildAssets({
      distDirectory: root,
      gracePeriodMs: 0,
    }),
    /at least one emitted asset/,
  );
  await fs.stat(oldAsset);
  await assert.rejects(fs.stat(path.join(root, ".asset-history")));
});

test("supports custom output paths and prunes expired history", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-custom-");
  const manifestPath = path.join(root, "build", "manifest.json");
  const assetsDirectory = path.join(root, "static");
  const historyDirectory = path.join(root, ".deploy-history");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.mkdir(path.join(assetsDirectory, "nested"), { recursive: true });
  await fs.mkdir(historyDirectory);
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ entry: { file: "static/current-12345678.js" } }),
  );
  await fs.writeFile(
    path.join(assetsDirectory, "current-12345678.js"),
    "current",
  );
  await fs.writeFile(
    path.join(historyDirectory, "0000000000001000.json"),
    JSON.stringify({ assets: ["static/previous-12345678.js"] }),
  );
  await fs.writeFile(
    path.join(historyDirectory, "0000000000000500.json"),
    JSON.stringify({ assets: ["static/expired-history-12345678.js"] }),
  );
  await fs.writeFile(path.join(historyDirectory, "notes.txt"), "ignored");
  const expired = path.join(
    assetsDirectory,
    "nested",
    "expired-12345678.css",
  );
  const secondExpired = path.join(
    assetsDirectory,
    "another-12345678.js",
  );
  const recent = path.join(assetsDirectory, "recent-12345678.js");
  const unmatched = path.join(assetsDirectory, "manual.js");
  for (const [file, modifiedAt] of [
    [expired, 0],
    [secondExpired, 0],
    [recent, 1_999],
    [unmatched, 0],
  ]) {
    await fs.writeFile(file, "asset");
    await fs.utimes(file, new Date(modifiedAt), new Date(modifiedAt));
  }

  const result = await retainBuildAssets({
    distDirectory: root,
    manifestPath,
    assetsDirectory,
    assetsBase: "static",
    historyDirectory,
    historyLimit: 2,
    gracePeriodMs: 100,
    nowMs: 2_000,
  });

  assert.deepEqual(result.removable, [
    "static/another-12345678.js",
    "static/nested/expired-12345678.css",
  ]);
  assert.equal(result.retainedHistoryCount, 2);
  await assert.rejects(fs.stat(expired));
  await assert.rejects(fs.stat(secondExpired));
  await fs.stat(recent);
  await fs.stat(unmatched);
  await fs.stat(path.join(historyDirectory, "0000000000002000.json"));
  await fs.stat(path.join(historyDirectory, "0000000000001000.json"));
  await assert.rejects(
    fs.stat(path.join(historyDirectory, "0000000000000500.json")),
  );
  await fs.stat(path.join(historyDirectory, "notes.txt"));
});

test("validates retention option types and the manifest asset base", async () => {
  await assert.rejects(retainBuildAssets(null), /must be an object/);
  await assert.rejects(retainBuildAssets([]), /must be an object/);
  await assert.rejects(retainBuildAssets({}), /distDirectory is required/);
  await assert.rejects(
    retainBuildAssets({ distDirectory: ".", assetPattern: "js" }),
    /assetPattern/,
  );
  await assert.rejects(
    retainBuildAssets({ distDirectory: ".", dryRun: "yes" }),
    /dryRun/,
  );
  await assert.rejects(
    retainBuildAssets({ distDirectory: ".", nowMs: Number.POSITIVE_INFINITY }),
    /nowMs must be finite/,
  );

  const root = await makeTemporaryDirectory("vite-continuity-base-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".vite", "manifest.json"),
    JSON.stringify({ entry: { file: "assets/current-12345678.js" } }),
  );
  for (const assetsBase of ["", ".", "../assets"]) {
    await assert.rejects(
      retainBuildAssets({
        distDirectory: root,
        assetsBase,
        dryRun: true,
      }),
      /assetsBase/,
    );
  }
});

test("collects only supported manifest entry fields", () => {
  assert.deepEqual([...collectManifestAssets(null)], []);
  assert.deepEqual([...collectManifestAssets("manifest")], []);
  assert.deepEqual(
    [...collectManifestAssets({
      ignored: null,
      source: {
        file: "/assets/main-12345678.js",
        css: "assets/not-an-array.css",
        assets: [null, "", "/assets/logo.svg"],
      },
    })].sort(),
    ["assets/logo.svg", "assets/main-12345678.js"],
  );
});

test("rejects a manifest symlink that resolves outside the root", async () => {
  const root = await makeTemporaryDirectory("vite-manifest-root-");
  const outside = await makeTemporaryDirectory("vite-manifest-out-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  const externalManifest = path.join(outside, "manifest.json");
  await fs.writeFile(
    externalManifest,
    JSON.stringify({ entry: { file: "assets/main-12345678.js" } }),
  );
  await fs.symlink(
    externalManifest,
    path.join(root, ".vite", "manifest.json"),
  );

  await assert.rejects(
    retainBuildAssets({ distDirectory: root, dryRun: true }),
    /manifestPath resolves outside distDirectory/,
  );
});

test("rejects missing current assets before changing old assets", async () => {
  const root = await makeTemporaryDirectory("vite-missing-current-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".vite", "manifest.json"),
    JSON.stringify({ entry: { file: "assets/missing-12345678.js" } }),
  );
  const oldAsset = path.join(root, "assets", "old-12345678.js");
  await fs.writeFile(oldAsset, "old");
  await fs.utimes(oldAsset, new Date(0), new Date(0));

  await assert.rejects(
    retainBuildAssets({
      distDirectory: root,
      gracePeriodMs: 0,
    }),
    /manifest asset does not exist/,
  );
  await fs.stat(oldAsset);
  await assert.rejects(fs.stat(path.join(root, ".asset-history")));
});

test("rejects manifest assets that escape the distribution root", async () => {
  const root = await makeTemporaryDirectory("vite-asset-root-");
  await fs.mkdir(path.join(root, ".vite"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".vite", "manifest.json"),
    JSON.stringify({ entry: { file: "../outside-12345678.js" } }),
  );

  await assert.rejects(
    retainBuildAssets({
      distDirectory: root,
      dryRun: true,
    }),
    /manifest asset .* must stay within distDirectory/,
  );
});

test("allocates a distinct history file for same-clock generations", async () => {
  const root = await makeTemporaryDirectory("vite-history-collision-");
  const assets = path.join(root, "assets");
  const manifest = path.join(root, ".vite", "manifest.json");
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  await fs.mkdir(assets);
  const first = path.join(assets, "first-12345678.js");
  const second = path.join(assets, "second-12345678.js");
  await fs.writeFile(first, "first");
  await fs.utimes(first, new Date(0), new Date(0));
  await fs.writeFile(
    manifest,
    JSON.stringify({ entry: { file: "assets/first-12345678.js" } }),
  );
  await retainBuildAssets({
    distDirectory: root,
    nowMs: 1_000,
    historyLimit: 2,
    gracePeriodMs: 0,
  });
  await fs.writeFile(second, "second");
  await fs.utimes(second, new Date(0), new Date(0));
  await fs.writeFile(
    manifest,
    JSON.stringify({ entry: { file: "assets/second-12345678.js" } }),
  );

  await retainBuildAssets({
    distDirectory: root,
    nowMs: 1_000,
    historyLimit: 2,
    gracePeriodMs: 0,
  });

  await fs.stat(first);
  assert.deepEqual(
    (await fs.readdir(path.join(root, ".asset-history"))).sort(),
    ["0000000000001000.json", "0000000000001001.json"],
  );
});
