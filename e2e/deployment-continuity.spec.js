import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { retainBuildAssets } from "../src/retention.js";

const repositoryRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const recoveryModule = path.join(repositoryRoot, "src", "recovery.js");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

let temporaryRoot;
let sourceDirectory;
let firstGeneration;
let secondGeneration;
let liveDirectory;
let server;
let origin;
let deploymentClock;

const writeApplication = async (version) => {
  await fs.writeFile(
    path.join(sourceDirectory, "index.html"),
    `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Continuity ${version}</title></head>
  <body>
    <p id="build"></p>
    <p id="status">idle</p>
    <button id="load-lazy" type="button">Load lazy route</button>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`,
  );
  await fs.writeFile(
    path.join(sourceDirectory, "main.js"),
    `import { installViteRecovery } from "vite-deploy-continuity/recovery";

const recoveryEvents = JSON.parse(
  sessionStorage.getItem("continuity.e2e.events") ?? "[]"
);
const loadCount = Number(
  sessionStorage.getItem("continuity.e2e.loads") ?? "0"
) + 1;
sessionStorage.setItem("continuity.e2e.loads", String(loadCount));

installViteRecovery({
  onEvent(event) {
    recoveryEvents.push({
      type: event.type,
      attemptCount: event.attemptCount ?? null
    });
    sessionStorage.setItem(
      "continuity.e2e.events",
      JSON.stringify(recoveryEvents)
    );
  }
});

document.body.dataset.build = ${JSON.stringify(version)};
document.body.dataset.loadCount = String(loadCount);
document.body.dataset.recoveryCount = String(
  recoveryEvents.filter((event) => event.type === "reload").length
);
document.querySelector("#build").textContent = "app-${version}";
document.querySelector("#load-lazy").addEventListener("click", async () => {
  document.querySelector("#status").textContent = "loading";
  const lazy = await import("./lazy.js");
  document.querySelector("#status").textContent = lazy.message;
});
`,
  );
  await fs.writeFile(
    path.join(sourceDirectory, "lazy.js"),
    `export const message = "lazy-${version}";\n`,
  );
};

const buildGeneration = async (version, outputDirectory) => {
  await writeApplication(version);
  await build({
    root: sourceDirectory,
    base: "/",
    logLevel: "silent",
    resolve: {
      alias: {
        "vite-deploy-continuity/recovery": recoveryModule,
      },
    },
    build: {
      outDir: outputDirectory,
      emptyOutDir: true,
      manifest: true,
    },
  });
};

const requestPath = (requestUrl) => {
  const url = new URL(requestUrl, "http://continuity.invalid");
  const pathname = decodeURIComponent(url.pathname);
  return pathname === "/" ? "index.html" : pathname.replace(/^\/+/u, "");
};

const startServer = async () => {
  server = http.createServer(async (request, response) => {
    try {
      const relativePath = requestPath(request.url);
      const file = path.resolve(liveDirectory, relativePath);
      if (
        file !== liveDirectory
        && !file.startsWith(`${liveDirectory}${path.sep}`)
      ) {
        response.statusCode = 400;
        response.end();
        return;
      }
      const body = await fs.readFile(file);
      const extension = path.extname(file);
      response.statusCode = 200;
      response.setHeader(
        "Content-Type",
        contentTypes.get(extension) ?? "application/octet-stream",
      );
      response.setHeader(
        "Cache-Control",
        extension === ".html"
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      );
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
};

const resetToFirstGeneration = async () => {
  await fs.rm(liveDirectory, { recursive: true, force: true });
  await fs.cp(firstGeneration, liveDirectory, { recursive: true });
  deploymentClock = Date.now() + 60_000;
  await retainBuildAssets({
    distDirectory: liveDirectory,
    historyLimit: 2,
    gracePeriodMs: 0,
    nowMs: deploymentClock,
  });
};

const deploySecondGeneration = async (historyLimit) => {
  await fs.cp(secondGeneration, liveDirectory, {
    recursive: true,
    force: true,
  });
  deploymentClock += 1;
  return retainBuildAssets({
    distDirectory: liveDirectory,
    historyLimit,
    gracePeriodMs: 0,
    nowMs: deploymentClock,
  });
};

test.beforeAll(async () => {
  const createdRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "vite-continuity-e2e-"),
  );
  temporaryRoot = await fs.realpath(createdRoot);
  sourceDirectory = path.join(temporaryRoot, "source");
  firstGeneration = path.join(temporaryRoot, "generation-v1");
  secondGeneration = path.join(temporaryRoot, "generation-v2");
  liveDirectory = path.join(temporaryRoot, "live");
  await fs.mkdir(sourceDirectory);
  await buildGeneration("v1", firstGeneration);
  await buildGeneration("v2", secondGeneration);
  await fs.mkdir(liveDirectory);
  await startServer();
});

test.afterAll(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  if (temporaryRoot) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test.beforeEach(async () => {
  await resetToFirstGeneration();
});

test("an old lazy route loads from a retained Vite generation", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(page.locator("#build")).toHaveText("app-v1");

  const retention = await deploySecondGeneration(2);
  expect(retention.removable).toEqual([]);
  await page.locator("#load-lazy").click();

  await expect(page.locator("#status")).toHaveText("lazy-v1");
  await expect(page.locator("body")).toHaveAttribute("data-load-count", "1");
  await expect(page.locator("body")).toHaveAttribute(
    "data-recovery-count",
    "0",
  );
});

test("a pruned lazy route triggers one recovery reload to the new build", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(page.locator("#build")).toHaveText("app-v1");

  const retention = await deploySecondGeneration(1);
  expect(retention.removable.length).toBeGreaterThan(0);
  await page.locator("#load-lazy").click();

  await expect(page.locator("#build")).toHaveText("app-v2");
  await expect(page.locator("body")).toHaveAttribute("data-load-count", "2");
  await expect(page.locator("body")).toHaveAttribute(
    "data-recovery-count",
    "1",
  );
  await page.locator("#load-lazy").click();
  await expect(page.locator("#status")).toHaveText("lazy-v2");
  await expect(page.locator("body")).toHaveAttribute(
    "data-recovery-count",
    "1",
  );
});
