import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ASSET_PATTERNS = Object.freeze({
  code: /-[A-Za-z0-9_-]{8,}\.(?:css|js)$/,
  vite: /-[A-Za-z0-9_-]{8,}\.(?:(?:css|js|mjs)(?:\.map)?|avif|bmp|eot|gif|ico|jpeg|jpg|json|map|mp3|mp4|ogg|otf|pdf|png|svg|ttf|txt|wasm|webm|webmanifest|webp|woff|woff2|xml)(?:\.(?:br|gz))?$/,
});
const ASSET_PRESETS = new Set(Object.keys(ASSET_PATTERNS));
const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1_000;
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

export class RetentionLockError extends Error {
  constructor(lockPath) {
    super(`retention lock is already held: ${lockPath}`);
    this.name = "RetentionLockError";
    this.code = "ERR_RETENTION_LOCKED";
    this.lockPath = lockPath;
  }
}

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

const loadHistory = async (historyDirectory, names, nowMs) => {
  const assets = new Set();
  const generations = [];
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
    const historyAssets = Array.isArray(history.assets) ? history.assets : [];
    for (const asset of historyAssets) {
      assets.add(normalizePath(asset));
    }
    const storedTimestamp = typeof history.createdAt === "string"
      ? Date.parse(history.createdAt)
      : Number.NaN;
    const nameTimestamp = Number(name.slice(0, -".json".length));
    const timestamp = Number.isFinite(storedTimestamp)
      ? storedTimestamp
      : nameTimestamp;
    const validTimestamp = Number.isFinite(timestamp)
      && timestamp >= 0
      && timestamp <= 8_640_000_000_000_000;
    generations.push({
      historyFile: name,
      createdAt: validTimestamp ? new Date(timestamp).toISOString() : null,
      ageMs: validTimestamp ? Math.max(0, nowMs - timestamp) : null,
      assetCount: historyAssets.length,
      current: false,
    });
  }
  return { assets, generations };
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
    try {
      await fs.rm(temporary, { force: true });
    } catch {
      // Preserve the original history write error.
    }
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

const acquireRetentionLock = async ({
  lockPath,
  lockStaleMs,
  realRoot,
}) => {
  const lockDirectory = path.dirname(lockPath);
  await fs.mkdir(lockDirectory, { recursive: true });
  const realLockDirectory = await fs.realpath(lockDirectory);
  if (!isPathInside(realRoot, realLockDirectory)) {
    throw new RangeError("lockPath resolves outside distDirectory");
  }

  const token = randomUUID();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          token,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        })}\n`, "utf8");
      } catch (error) {
        try {
          await handle.close();
        } catch {
          // Preserve the original lock write error.
        }
        try {
          await fs.rm(lockPath, { force: true });
        } catch {
          // Preserve the original lock write error.
        }
        throw error;
      }
      await handle.close();
      return {
        lockPath,
        release: async () => {
          try {
            const metadata = await fs.lstat(lockPath);
            if (metadata.isSymbolicLink() || !metadata.isFile()) return;
            const lock = await readJson(lockPath);
            if (lock?.token === token) {
              await fs.rm(lockPath, { force: true });
            }
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Preserve the original lock acquisition error.
        }
      }
      if (error?.code !== "EEXIST") throw error;

      let metadata;
      try {
        metadata = await fs.lstat(lockPath);
      } catch (statError) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new TypeError("retention lock must be a regular file");
      }
      if (Date.now() - metadata.mtimeMs <= lockStaleMs) {
        throw new RetentionLockError(lockPath);
      }

      const stalePath = `${lockPath}.${randomUUID()}.stale`;
      try {
        await fs.rename(lockPath, stalePath);
        await fs.rm(stalePath, { force: true });
      } catch (renameError) {
        if (
          renameError?.code === "ENOENT"
          || renameError?.code === "EEXIST"
        ) {
          continue;
        }
        throw renameError;
      }
    }
  }
  throw new RetentionLockError(lockPath);
};

const matchesAssetPattern = (assetPattern, value) => {
  const previousLastIndex = assetPattern.lastIndex;
  try {
    assetPattern.lastIndex = 0;
    return assetPattern.test(value);
  } finally {
    assetPattern.lastIndex = previousLastIndex;
  }
};

const isProtectedAsset = (protectedAssets, asset) => (
  protectedAssets.has(asset)
  || (
    (asset.endsWith(".br") || asset.endsWith(".gz"))
    && protectedAssets.has(asset.slice(0, -3))
  )
);

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
    "assetPreset",
    "assetPattern",
    "dryRun",
    "lock",
    "lockPath",
    "lockStaleMs",
    "onEvent",
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
    assetPreset = "code",
    assetPattern,
    dryRun = false,
    lock = true,
    lockPath = path.join(historyDirectory, ".retention.lock"),
    lockStaleMs = DEFAULT_LOCK_STALE_MS,
    onEvent,
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
  if (!ASSET_PRESETS.has(assetPreset)) {
    throw new RangeError("assetPreset must be either \"code\" or \"vite\"");
  }
  if (assetPattern !== undefined && !(assetPattern instanceof RegExp)) {
    throw new TypeError("assetPattern must be a regular expression");
  }
  if (
    Object.hasOwn(options, "assetPattern")
    && Object.hasOwn(options, "assetPreset")
  ) {
    throw new TypeError("assetPattern and assetPreset are mutually exclusive");
  }
  if (typeof dryRun !== "boolean") {
    throw new TypeError("dryRun must be a boolean");
  }
  if (typeof lock !== "boolean") {
    throw new TypeError("lock must be a boolean");
  }
  if (
    typeof lockPath !== "string"
    || lockPath.length === 0
  ) {
    throw new TypeError("lockPath must be a non-empty string");
  }
  if (!Number.isFinite(lockStaleMs) || lockStaleMs <= 0) {
    throw new RangeError("lockStaleMs must be a positive finite number");
  }
  if (onEvent !== undefined && typeof onEvent !== "function") {
    throw new TypeError("onEvent must be a function");
  }

  const resolvedAssetPattern = assetPattern ?? ASSET_PATTERNS[assetPreset];
  const assetPolicy = assetPattern ? "custom" : assetPreset;
  const emit = (event) => {
    try {
      onEvent?.(Object.freeze(event));
    } catch {
      // Telemetry must never change retention behavior.
    }
  };

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
  const safeLockPath = await assertContainedPath({
    lexicalRoot,
    realRoot,
    candidate: lockPath,
    label: "lockPath",
  });
  if (
    safeLockPath === safeHistoryDirectory
    || !isPathInside(safeHistoryDirectory, safeLockPath)
  ) {
    throw new RangeError("lockPath must stay within historyDirectory");
  }
  const safeAssetsBase = normalizeAssetsBase(assetsBase);

  const currentAssets = collectManifestAssets(await readJson(safeManifestPath));
  if (currentAssets.size === 0) {
    throw new TypeError("manifest must contain at least one emitted asset");
  }
  await validateManifestAssets({
    lexicalRoot,
    realRoot,
    assets: currentAssets,
  });

  const executeRetention = async () => {
    const existingNames = await listHistoryNames(safeHistoryDirectory);
    const prospectiveName = nextHistoryName(nowMs, existingNames);
    const existingRetainedNames = existingNames.slice(0, historyLimit - 1);
    const retainedNames = [prospectiveName, ...existingRetainedNames];
    const loadedHistory = await loadHistory(
      safeHistoryDirectory,
      existingRetainedNames,
      nowMs,
    );
    const protectedAssets = loadedHistory.assets;
    currentAssets.forEach((asset) => protectedAssets.add(asset));
    const retainedGenerations = [
      {
        historyFile: prospectiveName,
        createdAt: new Date(nowMs).toISOString(),
        ageMs: 0,
        assetCount: currentAssets.size,
        current: true,
      },
      ...loadedHistory.generations,
    ];

    const cutoffMs = nowMs - gracePeriodMs;
    const removableCandidates = [];
    for (const relativeWithinAssets of await walkFiles(safeAssetsDirectory)) {
      if (!matchesAssetPattern(resolvedAssetPattern, relativeWithinAssets)) {
        continue;
      }
      const manifestRelative = path.posix.join(
        safeAssetsBase,
        relativeWithinAssets,
      );
      if (isProtectedAsset(protectedAssets, manifestRelative)) continue;
      const absolutePath = path.join(
        safeAssetsDirectory,
        relativeWithinAssets,
      );
      const stat = await fs.stat(absolutePath);
      if (stat.mtimeMs < cutoffMs) {
        removableCandidates.push({
          absolutePath,
          manifestRelative,
          sizeBytes: stat.size,
          ageMs: Math.max(0, nowMs - stat.mtimeMs),
        });
      }
    }
    removableCandidates.sort((left, right) => (
      compareText(left.manifestRelative, right.manifestRelative)
    ));
    const removable = removableCandidates.map(
      (candidate) => candidate.manifestRelative,
    );
    const removableBytes = removableCandidates.reduce(
      (total, candidate) => total + candidate.sizeBytes,
      0,
    );
    const oldestRemovableAgeMs = removableCandidates.length > 0
      ? Math.max(...removableCandidates.map((candidate) => candidate.ageMs))
      : null;

    emit({
      type: "planned",
      assetPolicy,
      currentAssetCount: currentAssets.size,
      retainedGenerations,
      removableAssetCount: removable.length,
      removableBytes,
      oldestRemovableAgeMs,
      dryRun,
    });

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
        emit({
          type: "asset-removed",
          asset: candidate.manifestRelative,
          sizeBytes: candidate.sizeBytes,
          ageMs: candidate.ageMs,
        });
      }
    }

    const result = {
      currentAssets: [...currentAssets].sort(),
      retainedHistoryCount: retainedNames.length,
      retainedGenerations,
      removable,
      removableBytes,
      oldestRemovableAgeMs,
      assetPolicy,
      dryRun,
    };
    emit({
      type: "completed",
      assetPolicy,
      removedAssetCount: dryRun ? 0 : removable.length,
      removedBytes: dryRun ? 0 : removableBytes,
      dryRun,
    });
    return result;
  };

  if (dryRun || !lock) return executeRetention();

  const retentionLock = await acquireRetentionLock({
    lockPath: safeLockPath,
    lockStaleMs,
    realRoot,
  });
  emit({
    type: "lock-acquired",
    lockPath: safeLockPath,
  });
  try {
    return await executeRetention();
  } finally {
    await retentionLock.release();
    emit({
      type: "lock-released",
      lockPath: safeLockPath,
    });
  }
};
