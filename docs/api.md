# API reference

The package is ESM-only. Every JavaScript export has a matching TypeScript
declaration.

## Retention

Import from `vite-deploy-continuity/retention` or the package root.

### `collectManifestAssets(manifest)`

Returns a `Set<string>` containing each manifest entry's `file`, `css`, and
`assets` values. Leading URL slashes are removed. Invalid entries are ignored;
this tolerant collector does not itself validate that a manifest is safe to
use for retention.

### `retainBuildAssets(options)`

Reads the current manifest, protects the configured number of recent
generations, identifies old eligible assets, records the current generation,
and deletes eligible assets unless `dryRun` is enabled.

Options:

| Option | Default | Meaning |
|---|---|---|
| `distDirectory` | required | Root boundary for every read, write, and deletion |
| `manifestPath` | `.vite/manifest.json` under dist | Current Vite manifest |
| `historyDirectory` | `.asset-history` under dist | Generation snapshots |
| `assetsDirectory` | `assets` under dist | Directory scanned recursively |
| `assetsBase` | `assets` | Prefix used for asset paths in the manifest |
| `historyLimit` | `5` | Total manifest generations retained, including current |
| `gracePeriodMs` | `86400000` | Minimum age before an unprotected file is eligible |
| `nowMs` | `Date.now()` | Clock override for deterministic operation and tests |
| `assetPreset` | `"code"` | Deletion candidate set: `"code"` or `"vite"` (see below) |
| `assetPattern` | unset | Custom deletion filter (`RegExp`); mutually exclusive with `assetPreset` |
| `dryRun` | `false` | Return the deletion plan without modifying files or taking a lock |
| `lock` | `true` | Acquire the cross-process retention lock for a mutating run |
| `lockPath` | `.retention.lock` under `historyDirectory` | Lock file location; must stay inside `historyDirectory` |
| `lockStaleMs` | `3600000` | Age past which an existing lock file is reclaimed |
| `onEvent` | unset | Observability callback (see below) |

The returned promise resolves to:

```ts
interface RetainBuildAssetsResult {
  currentAssets: string[];
  retainedHistoryCount: number;
  retainedGenerations: RetainedGeneration[];
  removable: string[];
  removableBytes: number;
  oldestRemovableAgeMs: number | null; // null when nothing is removable
  assetPolicy: "code" | "vite" | "custom";
  dryRun: boolean;
}

interface RetainedGeneration {
  historyFile: string;
  createdAt: string | null; // ISO timestamp, or null if unparseable
  ageMs: number | null;
  assetCount: number;
  current: boolean; // true for this run's current/prospective generation
}
```

The function rejects unknown options, invalid windows, path escapes, unsafe
symbolic links, malformed history files, manifests with no emitted assets, and
manifests whose current assets do not exist as files under the distribution
root. History files are written through a unique temporary file and renamed
into place. Same-clock runs receive distinct ordered history names.

The returned result fields are the deterministic source of truth for callers;
`onEvent` is for telemetry only.

#### Asset policy (`assetPreset` / `assetPattern`)

`assetPreset` selects which filenames in `assetsDirectory` are eligible for
deletion. In every preset, current and retained manifest assets stay protected,
the grace window still applies, a compressed `.br`/`.gz` sibling stays protected
while its original is protected, and unhashed or manually named files stay
ineligible.

- `"code"` (default) considers only generated `.js` and `.css` filenames with an
  eight-character-or-longer generated suffix.
- `"vite"` (opt-in) additionally considers hash-suffixed common Vite assets:
  `.mjs`, source maps, typical images, fonts, JSON, WebAssembly, media, web
  manifests, and their `.br`/`.gz` siblings. It does not claim to cover every
  possible plugin output.

`assetPattern` supplies a custom `RegExp` for unusual output and is the escape
hatch when no preset fits. `assetPreset` and `assetPattern` are mutually
exclusive. `assetPolicy` in the result reports which applied: `"code"`,
`"vite"`, or `"custom"`. Always review a `--dry-run` before broadening deletion
eligibility.

#### Cross-process lock

A mutating run acquires `<historyDirectory>/.retention.lock` (or `lockPath`) by
exclusive file creation. If another run already holds it, the call fails fast
with the exported `RetentionLockError`:

```ts
class RetentionLockError extends Error {
  readonly code: "ERR_RETENTION_LOCKED";
  readonly lockPath: string;
}
```

- `lock` defaults to `true`. Set it to `false` only when callers already
  serialize retention themselves.
- `lockPath` is configurable but must remain inside `historyDirectory` and
  cannot be the directory itself.
- `lockStaleMs` defaults to one hour. An older *regular* lock file is atomically
  moved aside and removed before retrying. There is no heartbeat, so the stale
  threshold must exceed the longest legitimate retention run.
- Dry runs never write and never take the lock.

The lock serializes retention processes for one distribution directory. It does
not make the multi-step asset/HTML deployment atomic and does not lock an
external upload process.

#### Observability (`onEvent`)

`onEvent(event)` receives frozen event objects during a run. Exceptions thrown
by the callback are swallowed so telemetry cannot change retention behavior.

| `event.type` | Payload |
|---|---|
| `lock-acquired` / `lock-released` | `lockPath` |
| `planned` | `assetPolicy`, `currentAssetCount`, `retainedGenerations`, `removableAssetCount`, `removableBytes`, `oldestRemovableAgeMs`, `dryRun` |
| `asset-removed` | `asset`, `sizeBytes`, `ageMs` (emitted only for real deletions) |
| `completed` | `assetPolicy`, `removedAssetCount`, `removedBytes` (both `0` on a dry run), `dryRun` |

```js
import { retainBuildAssets } from "vite-deploy-continuity/retention";

await retainBuildAssets({
  distDirectory: "dist",
  onEvent: (event) => {
    if (event.type === "planned") {
      console.log(
        `retention: ${event.removableAssetCount} assets `
        + `(${event.removableBytes} bytes) eligible under ${event.assetPolicy}`,
      );
    }
  },
});
```

## Browser recovery

Import from `vite-deploy-continuity/recovery` or the package root.

### `isDynamicImportFailure(error, patterns?)`

Returns whether an error matches a recognized stale dynamic-import message.
Custom patterns are case-insensitive, non-empty strings.

### `createRecoveryController(options?)`

Returns `{ recover, clearRecoveryQuery }`.

- `recover(error)` returns `true` after recording an attempt and requesting a
  location replacement. It returns `false` for unrelated errors or when the
  same normalized URL is still inside the recovery window.
- `clearRecoveryQuery()` removes only the configured recovery query parameter
  with `history.replaceState`.

Options:

| Option | Default |
|---|---|
| `windowObject` | `globalThis.window` |
| `storageKey` | `viteDeployContinuity.recovery` |
| `queryKey` | `__chunk_recovery` |
| `ttlMs` | `60000` |
| `now` | `Date.now` wrapper |
| `patterns` | built-in Vite and chunk-load messages |
| `onEvent` | unset (observability callback, see below) |

`onEvent(event)` receives frozen event objects. Exceptions thrown by the
callback are swallowed so instrumentation cannot cause or prevent a reload.

| `event.type` | Payload |
|---|---|
| `reload` | `url` (normalized), `reloadUrl`, `attemptedAt`, `attemptCount` (cumulative for that normalized URL), `error` |
| `suppressed` | `url`, `attemptedAt`, `previousAttemptedAt`, `attemptCount`, `remainingMs`, `error` |
| `query-cleared` | `url` (the cleaned URL) |

### `installViteRecovery(options?)`

Installs `vite:preloadError`, `unhandledrejection`, and `error` listeners, and
clears any leftover recovery query parameter from the current URL so the marker
added before a reload does not linger in the address bar. It returns an
uninstall function that removes those listeners. Recognized errors have their
default handling suppressed with `event.preventDefault()` only when a recovery
reload is actually requested.

### `wrapDynamicImport(loader, controller)`

Returns an async function that preserves the loader's arguments and receiver.
Successful values pass through. If the controller starts recovery, the returned
promise remains pending while the page navigates; otherwise the original error
is rethrown.

## Static serving

Import from `vite-deploy-continuity/static` or the package root.

### `resolvePathInside(rootDirectory, requestPath)`

Decodes and lexically resolves a request path under the root, returning `null`
for malformed encoding, invalid input, or traversal. This standalone helper is
lexical; the middleware also checks real paths to contain symbolic links.

### `findFreshPrecompressedVariant(options)`

Returns a fresh accepted `.br` or `.gz` sibling, or `null`. The highest client
quality wins and Brotli is the server preference for equal qualities. A sibling
must be at least as new as the original, within `mtimeToleranceMs`. Pass
`rootDirectory` to require real-path containment.

### `cacheControlForRequest(requestUrl, options?)`

Returns the versioned policy when the request is classified as versioned,
otherwise the unversioned policy.

Defaults:

- version parameter: `v`
- versioned: `public, max-age=31536000, immutable`
- unversioned: `public, max-age=300`

By default, any non-empty value of the version parameter selects the immutable
policy — so that value must identify immutable bytes (a content hash or build
id), never arbitrary request state. Two mutually exclusive, opt-in validators
tighten this classification:

- `versionPattern` (`RegExp`): at least one non-empty occurrence of the version
  parameter must match this pattern. The caller-owned `lastIndex` is preserved.
- `isVersioned(url: URL): boolean`: classify the original request URL directly —
  for example by validating a hashed pathname. It must return a boolean.

Configuring both throws. A validator is recommended for stronger enforcement
than the default non-empty check.

### `createPrecompressedMiddleware(options)`

Creates async Connect/Express-compatible middleware. `rootDirectory` is
required. Optional fields:

- `extensions`: recognized original extensions;
- `cacheControl`: options passed to `cacheControlForRequest`;
- `contentType(pathname)`: original media type resolver, or `null` to leave it
  unset.

The default extensions are `.css`, `.js`, `.json`, `.map`, `.mjs`, `.svg`,
`.txt`, `.wasm`, and `.xml`. HTML is opt-in so callers must choose its
revalidation policy explicitly.

The middleware only inspects `GET` and `HEAD` requests whose path carries a
recognized extension and resolves inside `rootDirectory`. Every other request —
non-`GET`/`HEAD`, a byte-range request, an unrecognized extension, or a path for
a file that does not exist — is passed to `next()` untouched. A path that
resolves outside the root, lexically or through a symbolic link, is answered
with `400` instead of being forwarded.

For a recognized asset that exists it adds `Vary: Accept-Encoding` and, when
`cacheControl` is configured, sets `Cache-Control` from the original request
URL's version classification — evaluated before any rewrite, and whether or not
a compressed sibling is found. Only when a fresh
`.br`/`.gz` sibling is selected does it additionally set `Content-Encoding`, set
the original `Content-Type` (unless the resolver returns `null`), and rewrite
`request.url` to the sibling before calling the downstream handler.

Invalid options throw synchronously when the middleware is created. An error
raised while handling a request — such as a throwing `contentType` resolver or
an unexpected filesystem error — is forwarded to `next(error)` before any
compressed rewrite is applied.
