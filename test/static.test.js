import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  cacheControlForRequest,
  createPrecompressedMiddleware,
  findFreshPrecompressedVariant,
  resolvePathInside,
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

test("rejects traversal outside the static root", () => {
  const root = path.join(os.tmpdir(), "static-root");
  assert.equal(resolvePathInside(root, "/data/file.json"), path.join(root, "data/file.json"));
  assert.equal(resolvePathInside(root, "/../../secret.txt"), null);
  assert.equal(resolvePathInside(root, "/%2e%2e/%2e%2e/secret.txt"), null);
});

test("requires a static root when creating middleware", () => {
  assert.throws(() => createPrecompressedMiddleware(), /rootDirectory/);
});

test("rejects a request that resolves through a symlink outside the root", async () => {
  const root = await makeTemporaryDirectory("precompressed-root-");
  const outside = await makeTemporaryDirectory("precompressed-outside-");
  await fs.writeFile(path.join(outside, "data.json"), "{}");
  await fs.symlink(outside, path.join(root, "linked"), "dir");

  let ended = false;
  let continued = false;
  const response = {
    setHeader: () => {},
    end: () => {
      ended = true;
    },
  };
  await createPrecompressedMiddleware({ rootDirectory: root })(
    {
      method: "GET",
      url: "/linked/data.json",
      headers: { "accept-encoding": "br" },
    },
    response,
    () => {
      continued = true;
    },
  );

  assert.equal(response.statusCode, 400);
  assert.equal(ended, true);
  assert.equal(continued, false);
});

test("does not select a compressed symlink outside the root", async () => {
  const root = await makeTemporaryDirectory("precompressed-variant-root-");
  const outside = await makeTemporaryDirectory("precompressed-variant-out-");
  const original = path.join(root, "data.json");
  const externalVariant = path.join(outside, "data.json.br");
  await fs.writeFile(original, "{}");
  await fs.writeFile(externalVariant, "br");
  await fs.symlink(externalVariant, `${original}.br`);

  assert.equal(await findFreshPrecompressedVariant({
    originalPath: original,
    acceptEncoding: "br",
    rootDirectory: root,
  }), null);
});

test("selects only a fresh accepted precompressed sibling", async () => {
  const root = await makeTemporaryDirectory("precompressed-");
  const original = path.join(root, "data.json");
  await fs.writeFile(original, "{}");
  await fs.writeFile(`${original}.br`, "br");
  await fs.utimes(original, new Date(1_000), new Date(1_000));
  await fs.utimes(`${original}.br`, new Date(1_000), new Date(1_000));
  const variant = await findFreshPrecompressedVariant({
    originalPath: original,
    acceptEncoding: "gzip, br",
  });
  assert.equal(variant.encoding, "br");

  await fs.utimes(original, new Date(10_000), new Date(10_000));
  assert.equal(await findFreshPrecompressedVariant({
    originalPath: original,
    acceptEncoding: "br",
    mtimeToleranceMs: 0,
  }), null);
});

test("honors zero-quality encodings", async () => {
  const root = await makeTemporaryDirectory("precompressed-q-");
  const original = path.join(root, "data.json");
  await fs.writeFile(original, "{}");
  await fs.writeFile(`${original}.br`, "br");
  assert.equal(await findFreshPrecompressedVariant({
    originalPath: original,
    acceptEncoding: "br;q=0, gzip;q=1",
  }), null);
  assert.equal(await findFreshPrecompressedVariant({
    originalPath: original,
    acceptEncoding: "br;q=2",
  }), null);
  await assert.rejects(
    findFreshPrecompressedVariant({
      originalPath: original,
      acceptEncoding: "br",
      mtimeToleranceMs: -1,
    }),
    /mtimeToleranceMs/,
  );
});

test("preserves existing Vary response values", async () => {
  const root = await makeTemporaryDirectory("precompressed-vary-");
  const original = path.join(root, "data.json");
  await fs.writeFile(original, "{}");
  await fs.writeFile(`${original}.br`, "br");
  const headers = new Map([["vary", "Origin"]]);
  const response = {
    getHeader: (name) => headers.get(name.toLowerCase()),
    setHeader: (name, value) => headers.set(name.toLowerCase(), value),
    end: () => {},
  };
  let continued = false;
  await createPrecompressedMiddleware({ rootDirectory: root })(
    {
      method: "GET",
      url: "/data.json",
      headers: { "accept-encoding": "br" },
    },
    response,
    () => {
      continued = true;
    },
  );
  assert.equal(continued, true);
  assert.equal(headers.get("vary"), "Origin, Accept-Encoding");
  assert.equal(headers.get("content-encoding"), "br");
});

test("uses immutable caching only for versioned URLs", () => {
  assert.match(cacheControlForRequest("/asset.js?v=abc"), /immutable/);
  assert.doesNotMatch(cacheControlForRequest("/asset.js"), /immutable/);
  assert.doesNotMatch(cacheControlForRequest("/asset.js?v="), /immutable/);
  assert.throws(
    () => cacheControlForRequest("/asset.js", { versionParameter: "" }),
    /versionParameter/,
  );
});

test("supports explicit immutable-version validation", () => {
  const versionPattern = /^[a-f0-9]{8}$/gu;
  versionPattern.lastIndex = 3;
  assert.match(
    cacheControlForRequest("/asset.js?v=deadbeef", { versionPattern }),
    /immutable/u,
  );
  assert.doesNotMatch(
    cacheControlForRequest("/asset.js?v=session", { versionPattern }),
    /immutable/u,
  );
  assert.equal(versionPattern.lastIndex, 3);

  let receivedUrl;
  assert.match(
    cacheControlForRequest("/assets/app-12345678.js?release=42", {
      isVersioned: (url) => {
        receivedUrl = url;
        return /-[A-Za-z0-9_-]{8,}\.js$/u.test(url.pathname);
      },
    }),
    /immutable/u,
  );
  assert.equal(receivedUrl.pathname, "/assets/app-12345678.js");
  assert.throws(
    () => cacheControlForRequest("/asset.js", {
      versionPattern: /./u,
      isVersioned: () => true,
    }),
    /mutually exclusive/u,
  );
  assert.throws(
    () => cacheControlForRequest("/asset.js", { versionPattern: "hash" }),
    /versionPattern/u,
  );
  assert.throws(
    () => cacheControlForRequest("/asset.js", { isVersioned: true }),
    /isVersioned must be a function/u,
  );
  assert.throws(
    () => cacheControlForRequest("/asset.js", {
      isVersioned: () => "yes",
    }),
    /return a boolean/u,
  );
});

test("leaves byte-range requests to the downstream static server", async () => {
  let continued = false;
  const response = {
    setHeader: () => {
      throw new Error("headers must not be changed");
    },
  };
  await createPrecompressedMiddleware({ rootDirectory: "/tmp" })(
    {
      method: "GET",
      url: "/data.json",
      headers: { range: "bytes=0-9", "accept-encoding": "br" },
    },
    response,
    () => {
      continued = true;
    },
  );
  assert.equal(continued, true);
});

test("prefers the accepted encoding with the highest quality", async () => {
  const root = await makeTemporaryDirectory("precompressed-quality-");
  const original = path.join(root, "app.js");
  await fs.writeFile(original, "source");
  await fs.writeFile(`${original}.br`, "brotli");
  await fs.writeFile(`${original}.gz`, "gzip");

  const gzip = await findFreshPrecompressedVariant({
    originalPath: original,
    acceptEncoding: "br;q=0.2, gzip;q=0.9",
  });
  assert.equal(gzip.encoding, "gzip");

  const brotli = await findFreshPrecompressedVariant({
    originalPath: original,
    acceptEncoding: "gzip;q=0.5, br;q=0.5",
  });
  assert.equal(brotli.encoding, "br");

  const wildcard = await findFreshPrecompressedVariant({
    originalPath: original,
    acceptEncoding: "br;q=0, *;q=0.8",
  });
  assert.equal(wildcard.encoding, "gzip");
});

test("falls back to another accepted fresh encoding", async () => {
  const root = await makeTemporaryDirectory("precompressed-fallback-");
  const original = path.join(root, "app.js");
  await fs.writeFile(original, "source");
  await fs.writeFile(`${original}.br`, "brotli");

  const variant = await findFreshPrecompressedVariant({
    originalPath: original,
    acceptEncoding: "gzip;q=1, br;q=0.5",
  });
  assert.equal(variant.encoding, "br");
});

test("validates path resolution and precompressed lookup inputs", async () => {
  assert.equal(resolvePathInside("", "/asset.js"), null);
  assert.equal(resolvePathInside("/tmp", 1), null);
  assert.equal(resolvePathInside("/tmp", "/%E0%A4%A"), null);
  await assert.rejects(
    findFreshPrecompressedVariant({
      originalPath: "",
      acceptEncoding: "br",
    }),
    /originalPath/,
  );
  await assert.rejects(
    findFreshPrecompressedVariant({
      originalPath: "/tmp/missing.js",
      acceptEncoding: "br",
      rootDirectory: "",
    }),
    /rootDirectory/,
  );
  assert.equal(await findFreshPrecompressedVariant({
    originalPath: "/tmp/definitely-missing-vite-asset.js",
    acceptEncoding: "br",
  }), null);
});

test("supports custom cache policies and validates their values", () => {
  assert.equal(
    cacheControlForRequest("/asset.js?rev=&rev=two", {
      versionParameter: "rev",
      versioned: "immutable-custom",
      unversioned: "short-custom",
    }),
    "immutable-custom",
  );
  assert.equal(
    cacheControlForRequest("/asset.js", {
      versionParameter: "rev",
      versioned: "immutable-custom",
      unversioned: "short-custom",
    }),
    "short-custom",
  );
  assert.throws(
    () => cacheControlForRequest("/asset.js", { versioned: null }),
    /policies must be strings/,
  );
});

test("validates middleware options", () => {
  assert.throws(
    () => createPrecompressedMiddleware(null),
    /must be an object/,
  );
  assert.throws(
    () => createPrecompressedMiddleware({
      rootDirectory: "/tmp",
      unknown: true,
    }),
    /unknown middleware option/,
  );
  for (const extensions of [[], ["js"], ["."]]) {
    assert.throws(
      () => createPrecompressedMiddleware({
        rootDirectory: "/tmp",
        extensions,
      }),
      /extensions/,
    );
  }
  assert.throws(
    () => createPrecompressedMiddleware({
      rootDirectory: "/tmp",
      contentType: "application/json",
    }),
    /contentType/,
  );
  assert.throws(
    () => createPrecompressedMiddleware({
      rootDirectory: "/tmp",
      cacheControl: null,
    }),
    /cacheControl/,
  );
  assert.throws(
    () => createPrecompressedMiddleware({
      rootDirectory: "/tmp",
      cacheControl: { versioned: null },
    }),
    /policies must be strings/,
  );
  assert.doesNotThrow(
    () => createPrecompressedMiddleware({
      rootDirectory: "/tmp",
      cacheControl: { isVersioned: () => true },
    }),
  );
});

test("rewrites common Vite assets with their original media type", async () => {
  const root = await makeTemporaryDirectory("precompressed-vite-");
  const original = path.join(root, "app-12345678.js");
  await fs.writeFile(original, "source");
  await fs.writeFile(`${original}.br`, "brotli");
  const headers = new Map();
  const response = {
    getHeader: (name) => headers.get(name.toLowerCase()),
    setHeader: (name, value) => headers.set(name.toLowerCase(), value),
    end: () => {},
  };
  const request = {
    method: "GET",
    url: "/app-12345678.js?v=build-1",
    headers: { "accept-encoding": "br" },
  };
  let continued = false;

  await createPrecompressedMiddleware({
    rootDirectory: root,
    cacheControl: {},
  })(request, response, () => {
    continued = true;
  });

  assert.equal(continued, true);
  assert.equal(request.url, "/app-12345678.js.br?v=build-1");
  assert.equal(headers.get("content-encoding"), "br");
  assert.equal(headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(headers.get("cache-control"), /immutable/);
  assert.equal(headers.get("vary"), "Accept-Encoding");
});

test("evaluates immutable predicates against the original request URL", async () => {
  const root = await makeTemporaryDirectory("precompressed-versioned-");
  const original = path.join(root, "app-12345678.js");
  await fs.writeFile(original, "source");
  await fs.writeFile(`${original}.br`, "brotli");
  const headers = new Map();
  const request = {
    method: "GET",
    url: "/app-12345678.js",
    headers: { "accept-encoding": "br" },
  };

  await createPrecompressedMiddleware({
    rootDirectory: root,
    cacheControl: {
      isVersioned: (url) => url.pathname.endsWith(".js"),
    },
  })(
    request,
    {
      getHeader: (name) => headers.get(name.toLowerCase()),
      setHeader: (name, value) => headers.set(name.toLowerCase(), value),
      end: () => {},
    },
    () => {},
  );

  assert.equal(request.url, "/app-12345678.js.br");
  assert.match(headers.get("cache-control"), /immutable/u);
});

test("supports custom extensions and media types", async () => {
  const root = await makeTemporaryDirectory("precompressed-custom-");
  const original = path.join(root, "data.custom");
  await fs.writeFile(original, "source");
  await fs.writeFile(`${original}.gz`, "gzip");
  const headers = new Map();
  const request = {
    method: "HEAD",
    url: "/data.custom",
    headers: { "accept-encoding": "gzip" },
  };

  await createPrecompressedMiddleware({
    rootDirectory: root,
    extensions: [".custom"],
    contentType: () => "application/x-custom",
  })(
    request,
    {
      getHeader: (name) => headers.get(name.toLowerCase()),
      setHeader: (name, value) => headers.set(name.toLowerCase(), value),
      end: () => {},
    },
    () => {},
  );

  assert.equal(request.url, "/data.custom.gz");
  assert.equal(headers.get("content-type"), "application/x-custom");
  assert.equal(headers.get("content-encoding"), "gzip");
});

test("passes through unrelated, missing, and malformed requests", async () => {
  const root = await makeTemporaryDirectory("precompressed-pass-");
  const middleware = createPrecompressedMiddleware({ rootDirectory: root });
  const response = {
    setHeader: () => {},
    end: () => {},
  };
  for (const request of [
    { method: "POST", url: "/app.js", headers: {} },
    { method: "GET", url: "/image.png", headers: {} },
    { method: "GET", url: "/missing.js", headers: {} },
    { method: "GET", url: "http://[", headers: {} },
  ]) {
    let continued = false;
    await middleware(request, response, () => {
      continued = true;
    });
    assert.equal(continued, true);
  }
});

test("does not duplicate an existing Accept-Encoding Vary value", async () => {
  const root = await makeTemporaryDirectory("precompressed-vary-");
  const original = path.join(root, "app.js");
  await fs.writeFile(original, "source");
  const headers = new Map([["vary", "accept-encoding"]]);

  await createPrecompressedMiddleware({ rootDirectory: root })(
    {
      method: "GET",
      url: "/app.js",
      headers: {},
    },
    {
      getHeader: (name) => headers.get(name.toLowerCase()),
      setHeader: (name, value) => headers.set(name.toLowerCase(), value),
      end: () => {},
    },
    () => {},
  );

  assert.equal(headers.get("vary"), "accept-encoding");
});

test("leaves HTML compression opt-in to preserve revalidation policy", async () => {
  const root = await makeTemporaryDirectory("precompressed-html-");
  const original = path.join(root, "index.html");
  await fs.writeFile(original, "<!doctype html>");
  await fs.writeFile(`${original}.br`, "brotli");
  const request = {
    method: "GET",
    url: "/index.html",
    headers: { "accept-encoding": "br" },
  };
  const headers = new Map();

  await createPrecompressedMiddleware({ rootDirectory: root })(
    request,
    {
      getHeader: (name) => headers.get(name.toLowerCase()),
      setHeader: (name, value) => headers.set(name.toLowerCase(), value),
      end: () => {},
    },
    () => {},
  );

  assert.equal(request.url, "/index.html");
  assert.equal(headers.size, 0);
});

test("forwards custom resolver failures without partially rewriting", async () => {
  const root = await makeTemporaryDirectory("precompressed-error-");
  const original = path.join(root, "app.js");
  await fs.writeFile(original, "source");
  await fs.writeFile(`${original}.br`, "brotli");
  const request = {
    method: "GET",
    url: "/app.js",
    headers: { "accept-encoding": "br" },
  };
  const headers = new Map();
  const failure = new Error("media type lookup failed");
  let forwarded;

  await createPrecompressedMiddleware({
    rootDirectory: root,
    contentType: () => {
      throw failure;
    },
  })(
    request,
    {
      getHeader: (name) => headers.get(name.toLowerCase()),
      setHeader: (name, value) => headers.set(name.toLowerCase(), value),
      end: () => {},
    },
    (error) => {
      forwarded = error;
    },
  );

  assert.equal(forwarded, failure);
  assert.equal(request.url, "/app.js");
  assert.equal(headers.has("content-encoding"), false);
});
