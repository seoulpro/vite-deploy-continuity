import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_ASSET_PATTERN = /-[A-Za-z0-9_-]{8,}\.(?:css|js)$/;
const normalizePath = (value) => String(value ?? "").replace(/^\/+/, "");
const readJson = async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8"));
const compareText = (left, right) => (
  left < right ? -1 : left > right ? 1 : 0
);
const historyName = (timestamp) => (
  `${String(timestamp).padStart(16, "0")}.json`
);
const isPathInside = (root, candidate) => (
  candidate === root || candidate.startsWith(`${root}${path.sep}`)
);

const nearestExistingRealPath = async (candidate) => {
  let cursor = candidate;
  while (true) {
    try {
      return await fs.realpath(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
};

const assertContainedPath = async ({
  lexicalRoot,
  realRoot,
  candidate,
  label,
}) => {
  const resolved = path.resolve(candidate);
  if (!isPathInside(lexicalRoot, resolved)) {
    throw new RangeError(`${label} must stay within distDirectory`);
  }
  const realAncestor = await nearestExistingRealPath(resolved);
  if (!isPathInside(realRoot, realAncestor)) {
    throw new RangeError(`${label} resolves outside distDirectory`);
  }
  return resolved;
};

const normalizeAssetsBase = (value) => {
  const normalized = String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  if (
    !normalized
    || normalized.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new RangeError("assetsBase must be a non-empty relative path");
  }
  return normalized;
};

export const collectManifestAssets = (manifest) => {
  const assets = new Set();
  if (!manifest || typeof manifest !== "object") return assets;
  for (const entry of Object.values(manifest)) {
    if (!entry || typeof entry !== "object") continue;
    [
      entry.file,
      ...(Array.isArray(entry.css) ? entry.css : []),
      ...(Array.isArray(entry.assets) ? entry.assets : []),
    ]
      .map(normalizePath)
      .filter(Boolean)
      .forEach((asset) => assets.add(asset));
  }
  return assets;
};

const listHistoryNames = async (historyDirectory) => {
  try {
    return (await fs.readdir(historyDirectory))
      .filter((name) => /^\d+\.json$/.test(name))
      .sort()
      .reverse();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
};

const loadHistoryAssets = async (historyDirectory, names) => {
  const assets = new Set();
  for (const name of names) {
    const file = path.join(historyDirectory, name);
    const metadata = await fs.lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TypeError(`asset history must be a regular file: ${name}`);
    }
    const [realDirectory, realFile] = await Promise.all([
      fs.realpath(historyDirectory),
      fs.realpath(file),
    ]);
    if (!isPathInside(realDirectory, realFile)) {
      throw new RangeError(`asset history resolves outside its directory: ${name}`);
    }
    const history = await readJson(realFile);
    for (const asset of Array.isArray(history.assets) ? history.assets : []) {
      assets.add(normalizePath(asset));
    }
  }
  return assets;
};

const nextHistoryName = (nowMs, existingNames) => {
  const occupied = new Set(existingNames);
  let timestamp = Math.floor(nowMs);
  while (occupied.has(historyName(timestamp))) {
    timestamp += 1;
    if (timestamp > 8_640_000_000_000_000) {
      throw new RangeError("unable to allocate a unique asset history name");
    }
  }
  return historyName(timestamp);
};

const validateManifestAssets = async ({
  lexicalRoot,
  realRoot,
  assets,
}) => {
  for (const asset of assets) {
    const assetPath = await assertContainedPath({
      lexicalRoot,
      realRoot,
      candidate: path.join(lexicalRoot, asset),
      label: `manifest asset ${JSON.stringify(asset)}`,
    });
    let metadata;
    try {
      metadata = await fs.stat(assetPath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new TypeError(`manifest asset does not exist: ${asset}`);
      }
      throw error;
    }
    if (!metadata.isFile()) {
      throw new TypeError(`manifest asset must be a file: ${asset}`);
    }
  }
};

const writeHistory = async ({
  historyDirectory,
  name,
  nowMs,
  assets,
}) => {
  await fs.mkdir(historyDirectory, { recursive: true });
  const file = path.join(historyDirectory, name);
  let mode;
  try {
    const metadata = await fs.lstat(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TypeError(`asset history must be a regular file: ${name}`);
    }
    mode = metadata.mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const value = {
    createdAt: new Date(nowMs).toISOString(),
    assets: [...assets].sort(),
  };
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        ...(mode === undefined ? {} : { mode }),
      },
    );
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return name;
};

const walkFiles = async (directory, relativeDirectory = "") => {
  let entries;
  try {
    entries = await fs.readdir(path.join(directory, relativeDirectory), {
      withFileTypes: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(directory, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
};

export const retainBuildAssets = async (options = {}) => {
  if (
    typeof options !== "object"
    || options === null
    || Array.isArray(options)
  ) {
    throw new TypeError("retention options must be an object");
  }
  const allowedOptions = new Set([
    "distDirectory",
    "manifestPath",
    "historyDirectory",
    "assetsDirectory",
    "assetsBase",
    "historyLimit",
    "gracePeriodMs",
    "nowMs",
    "assetPattern",
    "dryRun",
  ]);
  for (const name of Object.keys(options)) {
    if (!allowedOptions.has(name)) {
      throw new TypeError(`unknown retention option: ${name}`);
    }
  }
  const {
    distDirectory,
    manifestPath = path.join(distDirectory ?? "", ".vite", "manifest.json"),
    historyDirectory = path.join(distDirectory ?? "", ".asset-history"),
    assetsDirectory = path.join(distDirectory ?? "", "assets"),
    assetsBase = "assets",
    historyLimit = 5,
    gracePeriodMs = 24 * 60 * 60 * 1_000,
    nowMs = Date.now(),
    assetPattern = DEFAULT_ASSET_PATTERN,
    dryRun = false,
  } = options;
  if (!distDirectory) throw new TypeError("distDirectory is required");
  if (!Number.isInteger(historyLimit) || historyLimit < 1) {
    throw new RangeError("historyLimit must be an integer of at least 1");
  }
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
    throw new RangeError("gracePeriodMs must be a non-negative finite number");
  }
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("nowMs must be finite");
  }
  if (nowMs < 0 || nowMs > 8_640_000_000_000_000) {
    throw new RangeError("nowMs must be within the JavaScript Date range");
  }
  if (!(assetPattern instanceof RegExp)) {
    throw new TypeError("assetPattern must be a regular expression");
  }
  if (typeof dryRun !== "boolean") {
    throw new TypeError("dryRun must be a boolean");
  }

  const lexicalRoot = path.resolve(distDirectory);
  const realRoot = await fs.realpath(lexicalRoot);
  const safeManifestPath = await assertContainedPath({
    lexicalRoot,
    realRoot,
    candidate: manifestPath,
    label: "manifestPath",
  });
  const safeHistoryDirectory = await assertContainedPath({
    lexicalRoot,
    realRoot,
    candidate: historyDirectory,
    label: "historyDirectory",
  });
  const safeAssetsDirectory = await assertContainedPath({
    lexicalRoot,
    realRoot,
    candidate: assetsDirectory,
    label: "assetsDirectory",
  });
  const safeAssetsBase = normalizeAssetsBase(assetsBase);

  const safeHistoryLimit = historyLimit;
  const currentAssets = collectManifestAssets(await readJson(safeManifestPath));
  if (currentAssets.size === 0) {
    throw new TypeError("manifest must contain at least one emitted asset");
  }
  await validateManifestAssets({
    lexicalRoot,
    realRoot,
    assets: currentAssets,
  });
  const existingNames = await listHistoryNames(safeHistoryDirectory);
  const prospectiveName = nextHistoryName(nowMs, existingNames);
  const existingRetainedNames = existingNames.slice(0, safeHistoryLimit - 1);
  const retainedNames = [prospectiveName, ...existingRetainedNames];
  const protectedAssets = await loadHistoryAssets(
    safeHistoryDirectory,
    existingRetainedNames,
  );
  currentAssets.forEach((asset) => protectedAssets.add(asset));

  const cutoffMs = nowMs - gracePeriodMs;
  const removableCandidates = [];
  for (const relativeWithinAssets of await walkFiles(safeAssetsDirectory)) {
    const previousLastIndex = assetPattern.lastIndex;
    let matches;
    try {
      assetPattern.lastIndex = 0;
      matches = assetPattern.test(relativeWithinAssets);
    } finally {
      assetPattern.lastIndex = previousLastIndex;
    }
    if (!matches) continue;
    const manifestRelative = path.posix.join(
      safeAssetsBase,
      relativeWithinAssets,
    );
    if (protectedAssets.has(manifestRelative)) continue;
    const absolutePath = path.join(safeAssetsDirectory, relativeWithinAssets);
    const stat = await fs.stat(absolutePath);
    if (stat.mtimeMs < cutoffMs) {
      removableCandidates.push({
        absolutePath,
        manifestRelative,
      });
    }
  }
  removableCandidates.sort((left, right) => (
    compareText(left.manifestRelative, right.manifestRelative)
  ));
  const removable = removableCandidates.map(
    (candidate) => candidate.manifestRelative,
  );

  if (!dryRun) {
    await writeHistory({
      historyDirectory: safeHistoryDirectory,
      name: prospectiveName,
      nowMs,
      assets: currentAssets,
    });
    for (const name of existingNames) {
      if (!retainedNames.includes(name)) {
        await fs.rm(path.join(safeHistoryDirectory, name), { force: true });
      }
    }
    for (const candidate of removableCandidates) {
      await fs.rm(candidate.absolutePath, { force: true });
    }
  }

  return {
    currentAssets: [...currentAssets].sort(),
    retainedHistoryCount: retainedNames.length,
    removable,
    dryRun,
  };
};
