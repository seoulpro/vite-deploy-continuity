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
generations, identifies old generated JavaScript and CSS, records the current
generation, and deletes eligible assets unless `dryRun` is enabled.

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
| `assetPattern` | generated `.js`/`.css` names | Filenames eligible for deletion; non-matching files are never removed |
| `dryRun` | `false` | Return the deletion plan without modifying files |

The returned promise resolves to:

```ts
interface RetainBuildAssetsResult {
  currentAssets: string[];
  retainedHistoryCount: number;
  removable: string[];
  dryRun: boolean;
}
```

The function rejects unknown options, invalid windows, path escapes, unsafe
symbolic links, malformed history files, manifests with no emitted assets, and
manifests whose current assets do not exist as files under the distribution
root. History files are written through a unique temporary file and renamed
into place. Same-clock runs receive distinct ordered history names.

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

Returns the versioned policy when the configured query parameter has a
non-empty value, otherwise the unversioned policy.

Defaults:

- version parameter: `v`
- versioned: `public, max-age=31536000, immutable`
- unversioned: `public, max-age=300`

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
`cacheControl` is configured, sets `Cache-Control` from the request's version
parameter — whether or not a compressed sibling is found. Only when a fresh
`.br`/`.gz` sibling is selected does it additionally set `Content-Encoding`, set
the original `Content-Type` (unless the resolver returns `null`), and rewrite
`request.url` to the sibling before calling the downstream handler.

Invalid options throw synchronously when the middleware is created. An error
raised while handling a request — such as a throwing `contentType` resolver or
an unexpected filesystem error — is forwarded to `next(error)` before any
compressed rewrite is applied.
