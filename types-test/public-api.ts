import {
  cacheControlForRequest,
  collectManifestAssets,
  createPrecompressedMiddleware,
  createRecoveryController,
  findFreshPrecompressedVariant,
  installViteRecovery,
  isDynamicImportFailure,
  resolvePathInside,
  retainBuildAssets,
  wrapDynamicImport,
  type RecoveryWindowLike,
  type RetainBuildAssetsOptions,
} from "vite-deploy-continuity";
import { installViteRecovery as installFromSubpath } from
  "vite-deploy-continuity/recovery";
import { retainBuildAssets as retainFromSubpath } from
  "vite-deploy-continuity/retention";
import { createPrecompressedMiddleware as middlewareFromSubpath } from
  "vite-deploy-continuity/static";

const manifestAssets: Set<string> = collectManifestAssets({
  entry: {
    file: "assets/main-12345678.js",
  },
});
void manifestAssets;

const retentionOptions: RetainBuildAssetsOptions = {
  distDirectory: "dist",
  historyLimit: 5,
  gracePeriodMs: 86_400_000,
  dryRun: true,
};
void retainBuildAssets(retentionOptions);
void retainFromSubpath(retentionOptions);

const browserWindow: RecoveryWindowLike = window;
const controller = createRecoveryController({
  windowObject: browserWindow,
  patterns: ["failed to fetch dynamically imported module"],
});
const loadValue = wrapDynamicImport(
  async (identifier: number) => ({ identifier }),
  controller,
);
const loaded: Promise<{ identifier: number }> = loadValue(1);
void loaded;
void installViteRecovery({ windowObject: browserWindow });
void installFromSubpath({ windowObject: browserWindow });
const failure: boolean = isDynamicImportFailure(new TypeError("Loading chunk"));
void failure;

const resolved: string | null = resolvePathInside("dist", "/assets/main.js");
void resolved;
const cachePolicy: string = cacheControlForRequest("/data.json?v=1");
void cachePolicy;
const variant = findFreshPrecompressedVariant({
  originalPath: "dist/assets/main.js",
  acceptEncoding: "br, gzip",
});
void variant;

const middleware = createPrecompressedMiddleware({
  rootDirectory: "dist",
  cacheControl: {
    versionParameter: "v",
  },
});
void middleware;
void middlewareFromSubpath({ rootDirectory: "dist" });
