import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
} from "node:zlib";

import { createPrecompressedMiddleware } from "../src/index.js";

const request = (port, pathname, headers = {}) => new Promise(
  (resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  },
);

test("serves negotiated precompressed Vite assets through Node HTTP", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vite-http-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = Buffer.from("export const answer = 42;\n");
  await fs.writeFile(path.join(root, "app-12345678.js"), source);
  await fs.writeFile(
    path.join(root, "app-12345678.js.br"),
    brotliCompressSync(source),
  );
  await fs.writeFile(
    path.join(root, "app-12345678.js.gz"),
    gzipSync(source),
  );

  const middleware = createPrecompressedMiddleware({
    rootDirectory: root,
    cacheControl: {},
  });
  const server = http.createServer((incoming, response) => {
    void middleware(incoming, response, async () => {
      try {
        const url = new URL(incoming.url, "http://localhost");
        const file = path.join(root, url.pathname.replace(/^\/+/u, ""));
        const body = await fs.readFile(file);
        response.statusCode = 200;
        response.setHeader("Content-Length", String(body.length));
        response.end(body);
      } catch {
        response.statusCode = 404;
        response.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  }));
  const address = server.address();
  assert.equal(typeof address, "object");

  const gzip = await request(
    address.port,
    "/app-12345678.js?v=release-1",
    { "Accept-Encoding": "br;q=0.5, gzip;q=1" },
  );
  assert.equal(gzip.statusCode, 200);
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.equal(gzip.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(gzip.headers.vary, "Accept-Encoding");
  assert.match(gzip.headers["cache-control"], /immutable/u);
  assert.deepEqual(gunzipSync(gzip.body), source);

  const brotli = await request(
    address.port,
    "/app-12345678.js",
    { "Accept-Encoding": "br, gzip;q=0.5" },
  );
  assert.equal(brotli.headers["content-encoding"], "br");
  assert.doesNotMatch(brotli.headers["cache-control"], /immutable/u);
  assert.deepEqual(brotliDecompressSync(brotli.body), source);

  const identity = await request(address.port, "/app-12345678.js");
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.deepEqual(identity.body, source);
});
