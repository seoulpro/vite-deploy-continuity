import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const run = (command, argumentsList, cwd) => {
  const environment = {
    ...process.env,
    NO_UPDATE_NOTIFIER: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  delete environment.npm_config_dry_run;
  delete environment.NPM_CONFIG_DRY_RUN;

  const result = spawnSync(command, argumentsList, {
    cwd,
    encoding: "utf8",
    env: environment,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${argumentsList.join(" ")} failed`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"),
    );
  }
  return result.stdout;
};

const temporaryRoot = await mkdtemp(
  join(tmpdir(), "vite-deploy-continuity-package-"),
);

try {
  const packOutput = run(
    npm,
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      temporaryRoot,
    ],
    projectRoot,
  );
  const [manifest] = JSON.parse(packOutput);
  assert.ok(manifest?.filename, "npm pack did not return a filename");

  const packedPaths = new Set(manifest.files.map((file) => file.path));
  for (const expected of [
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "bin/vite-retain-assets.js",
    "docs/api.md",
    "docs/deployment.md",
    "package.json",
    "src/index.d.ts",
    "src/index.js",
    "src/recovery.d.ts",
    "src/recovery.js",
    "src/retention.d.ts",
    "src/retention.js",
    "src/static.d.ts",
    "src/static.js",
  ]) {
    assert.ok(packedPaths.has(expected), `tarball is missing ${expected}`);
  }
  for (const packedPath of packedPaths) {
    assert.equal(packedPath.startsWith(".github/"), false);
    assert.equal(packedPath.startsWith("scripts/"), false);
    assert.equal(packedPath.startsWith("test/"), false);
    assert.equal(packedPath.startsWith("types-test/"), false);
  }

  const consumer = join(temporaryRoot, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  const tarball = join(temporaryRoot, manifest.filename);
  run(
    npm,
    ["install", "--ignore-scripts", tarball],
    consumer,
  );

  const smokePath = join(consumer, "smoke.mjs");
  await writeFile(
    smokePath,
    `
      import * as root from "vite-deploy-continuity";
      import * as recovery from "vite-deploy-continuity/recovery";
      import * as retention from "vite-deploy-continuity/retention";
      import * as staticHelpers from "vite-deploy-continuity/static";

      const expected = [
        "cacheControlForRequest",
        "collectManifestAssets",
        "createPrecompressedMiddleware",
        "createRecoveryController",
        "findFreshPrecompressedVariant",
        "installViteRecovery",
        "isDynamicImportFailure",
        "resolvePathInside",
        "retainBuildAssets",
        "wrapDynamicImport"
      ];
      if (expected.some((name) => typeof root[name] !== "function")) {
        process.exit(1);
      }
      if (typeof recovery.installViteRecovery !== "function") process.exit(2);
      if (typeof retention.retainBuildAssets !== "function") process.exit(3);
      if (typeof staticHelpers.createPrecompressedMiddleware !== "function") {
        process.exit(4);
      }
      const assets = root.collectManifestAssets({
        entry: { file: "assets/main-12345678.js" }
      });
      if (!assets.has("assets/main-12345678.js")) process.exit(5);
      if (!root.isDynamicImportFailure(new Error("Loading chunk 1 failed"))) {
        process.exit(6);
      }
      if (!root.cacheControlForRequest("/data.json?v=1").includes("immutable")) {
        process.exit(7);
      }
    `,
  );
  run(process.execPath, [smokePath], consumer);

  const binary = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32"
      ? "vite-retain-assets.cmd"
      : "vite-retain-assets",
  );
  const help = run(binary, ["--help"], consumer);
  assert.match(help, /^Usage:/u);

  const installedManifest = JSON.parse(
    await readFile(
      join(
        consumer,
        "node_modules",
        "vite-deploy-continuity",
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(installedManifest.version, manifest.version);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
