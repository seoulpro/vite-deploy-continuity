import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { collectManifestAssets, retainBuildAssets } from "../src/index.js";

// Exercise `retainBuildAssets` across repeated in-place Vite deployments and
// verify the continuity and storage bounds with a representative manifest.

const HASHED_ASSET = /-[0-9a-f]{8,}\.(?:css|js)$/u;
const temporaryDirectories = [];

after(async () => {
  await Promise.all(temporaryDirectories.map(
    (directory) => fs.rm(directory, { recursive: true, force: true }),
  ));
});

const makeTemporaryDirectory = async (prefix) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

// A tiny deployment simulator. Each release writes new hashed chunks into the
// live assets directory *without clearing prior ones* (deploy in place), then
// publishes a manifest that references only the current release's chunks.
const createDeployer = (root) => {
  const assetsDirectory = path.join(root, "assets");
  const manifestPath = path.join(root, ".vite", "manifest.json");
  let sequence = 0;
  let clockMs = 1_000_000_000_000;
  const currentHash = new Map();

  const chunkName = (kind) => `assets/${kind}-${currentHash.get(kind)}.js`;
  const cssName = () => `assets/index-${currentHash.get("index")}.css`;

  const rotate = (kind) => {
    sequence += 1;
    currentHash.set(kind, sequence.toString(16).padStart(8, "0"));
  };

  const writeAsset = async (relativeToAssets) => {
    const file = path.join(assetsDirectory, relativeToAssets);
    // Content is unique per hash; identical hashes keep identical bytes.
    await fs.writeFile(file, `// ${relativeToAssets}\n`);
    // Stamp a synthetic mtime so grace-window aging is deterministic across
    // the run regardless of wall-clock timing.
    await fs.utimes(file, new Date(clockMs), new Date(clockMs));
  };

  return {
    get assetsDirectory() {
      return assetsDirectory;
    },
    get clockMs() {
      return clockMs;
    },
    // release: mints new index + lazy-route hashes every time and rotates the
    // vendor hash occasionally, modelling a dependency that changes rarely.
    async deploy({ release, rotateVendor, historyLimit, gracePeriodMs }) {
      const retentionNowMs = clockMs;
      await fs.mkdir(assetsDirectory, { recursive: true });
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      rotate("index");
      rotate("about");
      if (rotateVendor || !currentHash.has("vendor")) rotate("vendor");

      // Write (or re-stamp) exactly the chunks this release references. An
      // unchanged vendor keeps its original, older mtime so it ages correctly.
      await writeAsset(`index-${currentHash.get("index")}.js`);
      await writeAsset(`index-${currentHash.get("index")}.css`);
      await writeAsset(`about-${currentHash.get("about")}.js`);
      if (rotateVendor || release === 1) {
        await writeAsset(`vendor-${currentHash.get("vendor")}.js`);
      }

      const manifest = {
        "src/main.js": {
          file: chunkName("index"),
          css: [cssName()],
          isEntry: true,
        },
        "src/about.js": { file: chunkName("about") },
        "vendor": { file: chunkName("vendor") },
      };
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const events = [];
      const result = await retainBuildAssets({
        distDirectory: root,
        historyLimit,
        gracePeriodMs,
        nowMs: retentionNowMs,
        onEvent: (event) => events.push(event),
      });
      clockMs += 3_600_000; // Advance one hour per deployment.
      return { result, events, manifest, retentionNowMs };
    },
  };
};

// The union of assets a still-open tab may legitimately request: everything the
// current manifest references plus everything any retained generation recorded.
const protectedUnion = async (root) => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, ".vite", "manifest.json"), "utf8"),
  );
  const union = collectManifestAssets(manifest);
  const historyDirectory = path.join(root, ".asset-history");
  for (const name of await fs.readdir(historyDirectory)) {
    if (!name.endsWith(".json")) continue;
    const generation = JSON.parse(
      await fs.readFile(path.join(historyDirectory, name), "utf8"),
    );
    for (const asset of generation.assets ?? []) union.add(asset);
  }
  return union;
};

const listHashedAssets = async (assetsDirectory) => (
  (await fs.readdir(assetsDirectory)).filter((name) => HASHED_ASSET.test(name))
);

test("keeps every referenced chunk across many in-place deployments", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-releases-");
  const deployer = createDeployer(root);
  const historyLimit = 4;
  const gracePeriodMs = 1_800_000; // 30 minutes, shorter than the deploy cycle.
  const totalReleases = 12;

  let cumulativeRemovedBytes = 0;
  let firstReclaimed = null;
  const onDiskAfterWarmup = [];

  for (let release = 1; release <= totalReleases; release += 1) {
    const { result, events } = await deployer.deploy({
      release,
      // Vendor changes every third release: an occasionally-updated dependency.
      rotateVendor: release % 3 === 0,
      historyLimit,
      gracePeriodMs,
    });

    const referenced = await protectedUnion(root);

    // Invariant 1 — continuity: nothing a retained tab may still request is
    // ever proposed for removal or missing from disk.
    for (const asset of referenced) {
      assert.ok(
        !result.removable.includes(asset),
        `release ${release} planned removal of referenced ${asset}`,
      );
      await fs.access(path.join(root, asset));
    }

    // Invariant 2 — reclaimed chunks are unreferenced and actually gone.
    for (const asset of result.removable) {
      assert.ok(
        !referenced.has(asset),
        `release ${release} removed still-referenced ${asset}`,
      );
      await assert.rejects(
        fs.access(path.join(root, asset)),
        `release ${release} left reclaimed ${asset} on disk`,
      );
    }

    // Invariant 3 — reclamation only past the grace window.
    if (result.oldestRemovableAgeMs !== null) {
      assert.ok(
        result.oldestRemovableAgeMs > gracePeriodMs,
        `release ${release} reclaimed within the grace window`,
      );
    }

    // Invariant 4 — reported telemetry matches the measured deletion.
    const completed = events.find((event) => event.type === "completed");
    assert.equal(completed.removedAssetCount, result.removable.length);
    assert.equal(completed.removedBytes, result.removableBytes);
    assert.equal(result.retainedGenerations.length, Math.min(release, historyLimit));

    cumulativeRemovedBytes += result.removableBytes;
    if (!firstReclaimed && result.removable.length > 0) {
      [firstReclaimed] = result.removable;
    }

    // Storage stays bounded: once past the retention window, every hashed file
    // on disk is one a retained generation still references — no orphans pile up.
    if (release > historyLimit) {
      const onDisk = await listHashedAssets(deployer.assetsDirectory);
      const referencedHashed = [...referenced].filter(
        (asset) => HASHED_ASSET.test(path.basename(asset)),
      );
      assert.equal(
        onDisk.length,
        referencedHashed.length,
        `release ${release} retained ${onDisk.length} chunks for `
          + `${referencedHashed.length} referenced`,
      );
      onDiskAfterWarmup.push(onDisk.length);
    }
  }

  // Measured evidence, not just invariants.
  assert.ok(cumulativeRemovedBytes > 0, "no stale chunks were ever reclaimed");
  assert.ok(firstReclaimed, "expected at least one chunk to age out");
  const steadyStateCeiling = Math.max(...onDiskAfterWarmup);
  assert.ok(
    steadyStateCeiling <= historyLimit * 4,
    `steady-state footprint ${steadyStateCeiling} exceeded the bound`,
  );
  // Footprint does not grow across the tail of the run.
  assert.ok(
    onDiskAfterWarmup.at(-1) <= onDiskAfterWarmup[0],
    "on-disk footprint grew after warm-up",
  );

  // Stale-client recovery linkage: a reclaimed chunk is genuinely gone, so a tab
  // still referencing it 404s and the browser controller performs exactly one
  // recovery reload (covered end-to-end in e2e/deployment-continuity.spec.js).
  await assert.rejects(fs.access(path.join(root, firstReclaimed)));
});

test("repeated dry runs produce the same plan without changing assets", async () => {
  const root = await makeTemporaryDirectory("vite-continuity-idempotent-");
  const deployer = createDeployer(root);
  const historyLimit = 3;
  const gracePeriodMs = 0;

  for (let release = 1; release <= 5; release += 1) {
    await deployer.deploy({
      release,
      rotateVendor: false,
      historyLimit,
      gracePeriodMs,
    });
  }
  const beforeUnion = await protectedUnion(root);

  // Operators commonly preview the same deployment more than once. Previewing
  // at a fixed clock must be deterministic and must not rotate history or
  // remove anything, even when the plan contains reclaimable assets.
  const beforeAssets = await listHashedAssets(deployer.assetsDirectory);
  const options = {
    distDirectory: root,
    historyLimit,
    gracePeriodMs,
    nowMs: deployer.clockMs,
    dryRun: true,
  };
  const first = await retainBuildAssets(options);
  const second = await retainBuildAssets(options);
  assert.deepEqual(second.removable, first.removable);
  assert.equal(second.removableBytes, first.removableBytes);
  assert.deepEqual(second.retainedGenerations, first.retainedGenerations);
  assert.deepEqual(
    await listHashedAssets(deployer.assetsDirectory),
    beforeAssets,
  );
  const afterUnion = await protectedUnion(root);
  assert.deepEqual([...afterUnion].sort(), [...beforeUnion].sort());
});
