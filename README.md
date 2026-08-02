# vite-deploy-continuity

When a Vite app is redeployed, tabs that were opened before the deploy still point at the
old build. The next lazy route or component they request is a chunk that is no longer on
the server, and the browser reports `Failed to fetch dynamically imported module`. What
the user sees is a blank panel, a navigation that does nothing, or a hard error page —
not because the code is wrong, but because the tab and the server disagree about which
build is current.

vite-deploy-continuity treats that window of version skew as a deployment concern rather
than a client-side bug. It retains the previous build's assets alongside the new one so a
stale tab can still fetch the chunks it was compiled against, recovers a failed dynamic
import once by reloading against the current build instead of surfacing the error, and
serves versioned and precompressed assets with headers that stay coherent while both
builds are reachable.

It does not manage releases, replace your router or error boundaries, or keep an
unbounded history of old builds alive.

## Is this for you?

The three layers are most valuable when several of these hold:

- browser tabs stay open long enough to outlive a deployment;
- the app uses lazy routes or code splitting, so a live tab can request a chunk
  it has not loaded yet;
- deployments happen in place, replacing or pruning an existing asset directory
  rather than publishing a brand-new immutable origin;
- you control the filesystem or CDN storage, so old-asset retention is
  something you can actually manage.

Under those conditions the layers reinforce each other:

- **ordinary stale clients keep working** by loading the chunks they still
  reference from the retained prior generations;
- **clients older than the retention window recover gracefully**: when a chunk
  is finally gone, they reload at most once within the configured recovery
  window instead of showing a broken screen;
- **static delivery stays coherent**, serving fresh precompressed siblings with
  matching cache and `Vary` headers so the recovery reload lands on assets that
  are actually cacheable.

Any one of these alone is a partial workaround; together they cover the common,
the edge, and the delivery cases of the same version-skew problem.

It may add little value if:

- your host serves each deployment from an immutable, per-deployment origin, or
  already retains every referenced generation for you;
- pages are short-lived or not code-split, so a tab rarely outlives a deploy or
  needs a chunk that changed;
- your pipeline never deletes prior content-hashed assets, so the specific
  failure this targets — a live tab requesting an old chunk that is already
  gone — cannot happen (other forms of deployment skew may still exist).

This reduces version-skew failures; it does not make a deployment atomic. See
the [deployment guide](./docs/deployment.md) for an adoption checklist and help
choosing retention settings.

## Install

```sh
npm install vite-deploy-continuity
```

Node.js 22 or newer is required. The package is ESM-only, includes TypeScript
declarations, and has no dependencies. Express is needed only when using the
Express example below.

## Asset retention CLI

Build with `manifest: true`, deploy new assets without clearing the directory,
preview the retention decision, and then prune:

```sh
vite-retain-assets --dist dist --dry-run

vite-retain-assets \
  --dist dist \
  --history-limit 5 \
  --grace-hours 24

# Opt in to pruning the broader Vite asset set:
vite-retain-assets --dist dist --asset-preset vite --dry-run
```

By default, deletion is deliberately limited to JavaScript and CSS filenames
with an eight-character-or-longer generated suffix (the `code` preset). The
opt-in `--asset-preset vite` also prunes hash-suffixed images, fonts, JSON,
WebAssembly, source maps, media, and their `.br`/`.gz` siblings; programmatic
callers can instead supply a custom `assetPattern` (mutually exclusive with a
preset). The default manifest path is `dist/.vite/manifest.json`, matching
current Vite output.

A mutating run takes a default cross-process lock in the history directory, so a
second run for the same directory fails fast instead of racing; dry runs stay
write-free and take no lock. The result fields and an optional `onEvent`
callback expose retained generations, removable bytes and ages, and — for
browser recovery — reload and suppression decisions; see the
[API reference](./docs/api.md).

Custom Vite layouts can set `--manifest`, `--assets-dir`, `--assets-base`, and
`--history-dir`. Relative file-system paths are resolved under `--dist`;
absolute paths must still remain within it.

The manifest, history, and asset paths must stay within `distDirectory`.
Resolved symbolic links are checked before any write or deletion. Run
`vite-retain-assets --help` for the complete CLI reference. An empty manifest
or a manifest that references a missing current asset is rejected so that a
broken build cannot make every old asset look unreferenced.

## Browser recovery

Install once near application bootstrap:

```js
import { installViteRecovery } from "vite-deploy-continuity/recovery";

installViteRecovery();
```

The controller listens to Vite's `vite:preloadError` event and common browser
chunk-load failures. It adds a one-time cache-busting query, which is stripped
from the URL once the page reloads, and stores a session-scoped attempt record
to prevent reload loops within the configured time window. If session storage
is unavailable, the query marker preserves the same one-attempt guard.

HTML should still be served with `Cache-Control: no-cache`.

## Static serving helpers

The static module provides:

- root-bounded request-path resolution with symbolic-link containment checks
  in the middleware;
- selection of `.br` or `.gz` siblings only when they are at least as fresh as
  the original, honoring the client's encoding quality preference while
  leaving range requests to the downstream server;
- immutable caching for versioned URLs — by default any non-empty version
  parameter, or a `versionPattern`/`isVersioned` validator for stricter
  classification;
- a Connect/Express-compatible precompressed middleware that does not depend
  on Express itself.

```js
import express from "express";
import {
  createPrecompressedMiddleware
} from "vite-deploy-continuity/static";

const app = express();
app.use(createPrecompressedMiddleware({
  rootDirectory: "/srv/app/dist",
  cacheControl: {
    // Mark ?v= immutable only when it is a real content hash, rather than
    // trusting any non-empty value (the compatibility default).
    versionPattern: /^[a-f0-9]{8,}$/
  }
}));
app.use(express.static("/srv/app/dist"));
```

Prefer `versionPattern` (or an `isVersioned(url)` predicate) so only genuinely
versioned requests receive the year-long immutable policy.

The middleware recognizes common Vite assets (`.js`, `.mjs`, `.css`, `.json`,
`.map`, `.svg`, `.txt`, `.xml`, and WebAssembly) by default. It sets the
original media type before rewriting the request to a compressed sibling. HTML
is opt-in so its required revalidation policy is not accidentally replaced;
pass `extensions` and `contentType` to customize the set.

## Deployment order

1. Upload the new hashed assets.
2. Publish HTML and manifest last.
3. Run bounded retention after publication.
4. Remove old assets only after the configured generation and time windows.

The package does not perform remote deployment, mutate server configuration, or
assume a particular CI provider.

Retention cannot make a multi-step deployment atomic. Validate history and
grace windows against real cache lifetimes, and exercise static middleware
ordering in staging. Defaults and API details may change during the `0.x`
series.

See the [deployment guide](./docs/deployment.md) for a staging checklist,
custom-layout example, and rollback procedure.
The [API reference](./docs/api.md) documents every exported function and
option.

## Development

```sh
npm ci
npm run verify
```

The real-browser end-to-end suite is separate from `npm run verify`:

```sh
npx playwright install chromium
npm run test:e2e
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for safety invariants and test
expectations. Report vulnerabilities as described in
[SECURITY.md](./SECURITY.md).

## Changelog

Release history is documented in [CHANGELOG.md](./CHANGELOG.md).

## Related projects

- [express-static-l10n](https://github.com/seoulpro/express-static-l10n) — a request-time
  layer over already-built static output.
- [playwright-render-contract](https://github.com/seoulpro/playwright-render-contract) —
  checking that a deployed page actually became usable, not just that it responded.
- [render-handoff-contract](https://github.com/seoulpro/render-handoff-contract) —
  continuity rules for a different transition: swapping renderers mid-view.

## License

[MIT](./LICENSE)
