#!/usr/bin/env node

import path from "node:path";

import { retainBuildAssets } from "../src/retention.js";

const usage = `Usage:
  vite-retain-assets [options]

Options:
  --dist <directory>       Vite output directory (default: dist)
  --manifest <path>        Manifest path, relative to dist by default
  --assets-dir <path>      Asset directory, relative to dist by default
  --assets-base <path>     Asset path used by the manifest (default: assets)
  --history-dir <path>     History directory, relative to dist by default
  --history-limit <count>  Number of manifest generations to retain (default: 5)
  --grace-hours <hours>    Minimum asset age before deletion (default: 24)
  --asset-preset <name>    Deletion candidates: code or vite (default: code)
  --lock-stale-minutes <n> Reclaim a stale retention lock (default: 60)
  --dry-run                Report changes without writing or deleting
  --help                   Show this help
`;

const valueAfter = (argumentsList, index, option) => {
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${option} requires a value`);
  }
  return value;
};

const parseArguments = (argumentsList) => {
  const options = {
    distDirectory: path.resolve("dist"),
    historyLimit: 5,
    gracePeriodMs: 24 * 60 * 60 * 1_000,
    dryRun: false,
  };
  const relativePaths = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help") return { help: true };
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--dist") {
      options.distDirectory = path.resolve(
        valueAfter(argumentsList, index, argument),
      );
      index += 1;
    } else if (argument === "--manifest") {
      relativePaths.manifestPath = valueAfter(argumentsList, index, argument);
      index += 1;
    } else if (argument === "--assets-dir") {
      relativePaths.assetsDirectory = valueAfter(argumentsList, index, argument);
      index += 1;
    } else if (argument === "--assets-base") {
      options.assetsBase = valueAfter(argumentsList, index, argument);
      index += 1;
    } else if (argument === "--history-dir") {
      relativePaths.historyDirectory = valueAfter(argumentsList, index, argument);
      index += 1;
    } else if (argument === "--history-limit") {
      options.historyLimit = Number(valueAfter(argumentsList, index, argument));
      index += 1;
    } else if (argument === "--grace-hours") {
      const hours = Number(valueAfter(argumentsList, index, argument));
      options.gracePeriodMs = hours * 60 * 60 * 1_000;
      index += 1;
    } else if (argument === "--asset-preset") {
      options.assetPreset = valueAfter(argumentsList, index, argument);
      index += 1;
    } else if (argument === "--lock-stale-minutes") {
      const minutes = Number(valueAfter(argumentsList, index, argument));
      options.lockStaleMs = minutes * 60 * 1_000;
      index += 1;
    } else {
      throw new TypeError(`unknown option: ${argument}`);
    }
  }
  for (const [name, value] of Object.entries(relativePaths)) {
    options[name] = path.resolve(options.distDirectory, value);
  }
  return { help: false, options };
};

try {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage);
  } else {
    const result = await retainBuildAssets(parsed.options);

    process.stdout.write(`${JSON.stringify({
      distDirectory: parsed.options.distDirectory,
      currentAssetCount: result.currentAssets.length,
      retainedHistoryCount: result.retainedHistoryCount,
      retainedGenerations: result.retainedGenerations,
      removable: result.removable,
      removableBytes: result.removableBytes,
      oldestRemovableAgeMs: result.oldestRemovableAgeMs,
      assetPolicy: result.assetPolicy,
      dryRun: result.dryRun,
    }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage}`);
  process.exitCode = 1;
}
