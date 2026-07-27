import fs from "node:fs/promises";
import path from "node:path";

const VARIANTS = Object.freeze([
  { extension: ".br", encoding: "br" },
  { extension: ".gz", encoding: "gzip" },
]);

const DEFAULT_EXTENSIONS = Object.freeze([
  ".css",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
  ".xml",
]);

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".xml": "application/xml; charset=utf-8",
});

const encodingQuality = (header, encoding) => {
  const qualities = new Map();
  for (const item of String(header ?? "").split(",")) {
    const [name, ...parameters] = item.trim().toLowerCase().split(";");
    if (!name) continue;
    let quality = 1;
    for (const parameter of parameters) {
      if (!/^\s*q\s*=/u.test(parameter)) continue;
      const match =
        /^\s*q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/u.exec(parameter);
      quality = match ? Number(match[1]) : 0;
    }
    qualities.set(name, Number.isFinite(quality) ? quality : 0);
  }
  const quality = qualities.has(encoding)
    ? qualities.get(encoding)
    : qualities.get("*");
  return Number(quality) > 0 ? Number(quality) : 0;
};

const appendVary = (response, value) => {
  const existing = response.getHeader?.("Vary");
  const values = String(existing ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) {
    values.push(value);
  }
  response.setHeader("Vary", values.join(", "));
};

const isPathInside = (root, candidate) => (
  candidate === root || candidate.startsWith(`${root}${path.sep}`)
);

const realPathContainment = async (rootDirectory, candidate) => {
  try {
    const [realRoot, realCandidate] = await Promise.all([
      fs.realpath(rootDirectory),
      fs.realpath(candidate),
    ]);
    return isPathInside(realRoot, realCandidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
};

export const resolvePathInside = (rootDirectory, requestPath) => {
  if (
    typeof rootDirectory !== "string"
    || rootDirectory.length === 0
    || typeof requestPath !== "string"
  ) {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, decoded.replace(/^[/\\]+/, ""));
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
    ? resolved
    : null;
};

export const findFreshPrecompressedVariant = async ({
  originalPath,
  acceptEncoding,
  mtimeToleranceMs = 0,
  rootDirectory,
}) => {
  if (typeof originalPath !== "string" || originalPath.length === 0) {
    throw new TypeError("originalPath must be a non-empty string");
  }
  if (
    !Number.isFinite(mtimeToleranceMs)
    || mtimeToleranceMs < 0
  ) {
    throw new TypeError(
      "mtimeToleranceMs must be a finite non-negative number",
    );
  }
  if (
    rootDirectory !== undefined
    && (typeof rootDirectory !== "string" || rootDirectory.length === 0)
  ) {
    throw new TypeError("rootDirectory must be a non-empty string");
  }
  let original;
  try {
    original = await fs.stat(originalPath);
  } catch {
    return null;
  }
  if (!original.isFile()) return null;
  if (
    rootDirectory
    && await realPathContainment(rootDirectory, originalPath) !== true
  ) {
    return null;
  }
  const acceptedVariants = VARIANTS
    .map((variant) => ({
      ...variant,
      quality: encodingQuality(acceptEncoding, variant.encoding),
    }))
    .filter((variant) => variant.quality > 0)
    .sort((left, right) => right.quality - left.quality);
  for (const variant of acceptedVariants) {
    try {
      const variantPath = `${originalPath}${variant.extension}`;
      const stat = await fs.stat(variantPath);
      if (
        stat.isFile()
        && stat.mtimeMs + mtimeToleranceMs >= original.mtimeMs
        && (
          !rootDirectory
          || await realPathContainment(rootDirectory, variantPath) === true
        )
      ) {
        return {
          path: variantPath,
          extension: variant.extension,
          encoding: variant.encoding,
        };
      }
    } catch {
      // Try the next accepted encoding.
    }
  }
  return null;
};

export const cacheControlForRequest = (
  requestUrl,
  {
    versionParameter = "v",
    versioned = "public, max-age=31536000, immutable",
    unversioned = "public, max-age=300",
  } = {},
) => {
  if (typeof versionParameter !== "string" || versionParameter.length === 0) {
    throw new TypeError("versionParameter must be a non-empty string");
  }
  if (typeof versioned !== "string" || typeof unversioned !== "string") {
    throw new TypeError("cache-control policies must be strings");
  }
  const url = new URL(requestUrl, "https://continuity.invalid");
  return url.searchParams
    .getAll(versionParameter)
    .some((value) => value.length > 0)
    ? versioned
    : unversioned;
};

/**
 * Connect/Express-compatible middleware that selects fresh .br/.gz siblings.
 * It does not serve files; mount it before the framework's static middleware.
 */
export const createPrecompressedMiddleware = (options = {}) => {
  if (
    typeof options !== "object"
    || options === null
    || Array.isArray(options)
  ) {
    throw new TypeError("middleware options must be an object");
  }
  for (const name of Object.keys(options)) {
    if (
      name !== "rootDirectory"
      && name !== "extensions"
      && name !== "cacheControl"
      && name !== "contentType"
    ) {
      throw new TypeError(`unknown middleware option: ${name}`);
    }
  }
  const {
    rootDirectory,
    extensions = DEFAULT_EXTENSIONS,
    cacheControl,
    contentType = (pathname) => (
      CONTENT_TYPES[path.extname(pathname).toLowerCase()] ?? null
    ),
  } = options;
  if (typeof rootDirectory !== "string" || rootDirectory.length === 0) {
    throw new TypeError("rootDirectory must be a non-empty string");
  }
  if (
    !Array.isArray(extensions)
    || extensions.length === 0
    || extensions.some(
      (extension) =>
        typeof extension !== "string"
        || !extension.startsWith(".")
        || extension.length < 2,
    )
  ) {
    throw new TypeError("extensions must contain one or more file extensions");
  }
  if (
    contentType !== undefined
    && contentType !== null
    && typeof contentType !== "function"
  ) {
    throw new TypeError("contentType must be a function or null");
  }
  if (
    cacheControl !== undefined
    && (
      typeof cacheControl !== "object"
      || cacheControl === null
      || Array.isArray(cacheControl)
    )
  ) {
    throw new TypeError("cacheControl must be an object");
  }
  if (cacheControl !== undefined) {
    cacheControlForRequest("/", cacheControl);
  }
  return async (request, response, next) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return next();
      if (request.headers?.range) return next();
      const url = new URL(request.url, "https://continuity.invalid");
      if (!extensions.some((extension) => url.pathname.endsWith(extension))) {
        return next();
      }
      const originalPath = resolvePathInside(rootDirectory, url.pathname);
      if (!originalPath) {
        response.statusCode = 400;
        return response.end();
      }
      const containment = await realPathContainment(rootDirectory, originalPath);
      if (containment === false) {
        response.statusCode = 400;
        return response.end();
      }
      if (containment === null) return next();

      appendVary(response, "Accept-Encoding");
      const variant = await findFreshPrecompressedVariant({
        originalPath,
        acceptEncoding: request.headers?.["accept-encoding"],
        rootDirectory,
      });
      const rewrittenUrl = variant
        ? `${url.pathname}${variant.extension}${url.search}`
        : request.url;
      const resolvedContentType = variant
        ? contentType?.(url.pathname)
        : null;
      const resolvedCacheControl = cacheControl
        ? cacheControlForRequest(rewrittenUrl, cacheControl)
        : null;
      if (variant) {
        response.setHeader("Content-Encoding", variant.encoding);
        if (resolvedContentType) {
          response.setHeader("Content-Type", resolvedContentType);
        }
        request.url = rewrittenUrl;
      }
      if (resolvedCacheControl) {
        response.setHeader("Cache-Control", resolvedCacheControl);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
};
