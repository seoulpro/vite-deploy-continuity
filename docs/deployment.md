# Deployment guide

`vite-deploy-continuity` reduces version-skew failures; it does not make a
multi-step deployment atomic. Use immutable, content-hashed asset URLs and
serve HTML with `Cache-Control: no-cache`.

## Adoption checklist

Confirm the fit before wiring this into a pipeline:

- [ ] Tabs stay open across deployments (long-lived SPA, dashboard, editor).
- [ ] The build is code-split, so a live tab can request a not-yet-loaded chunk.
- [ ] Deployments write in place and may delete or overwrite prior assets.
- [ ] You control the asset store (filesystem or CDN) well enough to retain and
      later prune old generations.
- [ ] HTML is served with `Cache-Control: no-cache` and assets are immutable and
      content-hashed.
- [ ] Retention runs do not overlap for a directory. The built-in lock enforces
      this by default; leave `lock` enabled unless you already serialize runs.

If most boxes are unchecked — for example an immutable per-deployment origin, a
host that already keeps every referenced generation, or a pipeline that never
deletes old assets — the package has little to add.

## Choose retention settings

`historyLimit` (`--history-limit`) bounds how many recent generations are
protected, and `gracePeriodMs` (`--grace-hours`) sets the minimum file age
before an unprotected asset becomes eligible for deletion. An asset survives if
it is in a protected generation **or** younger than the grace window, so size
both from measured values, not guesses:

- **Open-tab duration.** Measure how long real sessions stay open (analytics or
  a p95/p99 session length). Retention must outlast the tabs you intend to keep
  working: a tab older than every retained generation falls back to one recovery
  reload instead of loading in place.
- **Deploy frequency.** `historyLimit` counts generations, not time, and it
  includes the current snapshot: `5` protects the current generation plus four
  prior ones. Its wall-clock reach is roughly the number of *prior* generations
  times your deploy interval — about four intervals at a steady cadence, and
  variable when deploys are irregular. Translate the coverage you need into a
  generation count rather than assuming a fixed duration.
- **Edge and browser cache lifetime.** Keep old assets at least as long as
  caches may still hand out HTML that references them, so a cached page never
  points at a pruned chunk.
- **Rollback window.** Retain enough generations that rolling back to a previous
  release still finds its assets present. If they were already pruned, restore
  from the deployment artifact before republishing.
- **Storage budget.** More generations and a longer grace window cost disk or
  object storage. Pick the smallest window that satisfies the constraints above,
  then round up for headroom.

Treat the `--history-limit 5` and `--grace-hours 24` defaults as starting
values, not a recommendation: validate them against your measured sessions,
cache behavior, rollback needs, deploy cadence, and storage budget. Raise both
for long sessions or frequent deploys; a lower grace window only makes sense
when caches are short and sessions are brief.

## Scope and boundaries

- **Default deletion is narrow on purpose.** The default `code` preset makes
  only generated `.js` and `.css` files eligible for deletion. Other emitted
  asset types — images, fonts, JSON, WebAssembly, source maps, media — are not
  pruned by default, so they can accumulate. The opt-in `vite` preset
  (`--asset-preset vite`) extends eligibility to hash-suffixed Vite assets of
  those kinds and their `.br`/`.gz` siblings; it does not claim to cover every
  plugin output. A custom `assetPattern` remains the escape hatch for unusual
  output. Current, retained, and unhashed assets stay protected under every
  policy, but always review a `--dry-run` before broadening deletion, because
  the policy is the last guard against deleting a still-referenced file.
- **Retention is serialized by a lock, not made atomic.** A mutating run holds
  `<historyDirectory>/.retention.lock`; a concurrent run fails fast with
  `RetentionLockError` (`code: ERR_RETENTION_LOCKED`). Keep `lock` enabled (the
  default) unless you already serialize runs yourself. The lock guards retention
  processes for one directory only — it does not serialize your upload or HTML
  publication and does not make the multi-step deployment atomic, so still avoid
  overlapping external deploy steps. `lockStaleMs` (`--lock-stale-minutes`)
  defaults to one hour; with no heartbeat, a lock file older than that is
  reclaimed, so set it longer than the longest legitimate retention run to
  avoid reclaiming a live one.
- **Service workers are a separate cache generation.** A service worker adds its
  own precache and update lifecycle on top of HTTP caches. This package does not
  manage service workers; stage and test the worker's update and skip-waiting
  behavior as part of the application so it does not pin clients to assets this
  package has pruned.
- **Classify immutable requests deliberately.** By default the static cache
  helper treats a request as immutable when the configured version parameter
  (`v` by default) carries any non-empty value, sending
  `max-age=31536000, immutable`. That compatibility default trusts any non-empty
  value, so prefer a `versionPattern` (matching only real content hashes or
  build ids) or an `isVersioned(url)` predicate to enforce it. Never mark a
  request immutable from arbitrary request state such as a session or tracking
  token, which would cache stale or wrong content for a year.

## Build

Enable the Vite build manifest:

```js
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    manifest: true,
  },
});
```

Generate `.br` and `.gz` siblings before upload if the static server will use
the precompressed middleware. A compressed sibling older than its original is
ignored.

## Publish

Use this order:

1. Upload all new content-hashed assets and their compressed siblings.
2. Verify that the new assets are readable from the public origin.
3. Publish HTML and `.vite/manifest.json` last.
4. Preview retention with `vite-retain-assets --dist dist --dry-run`.
5. Run retention only after the preview matches the intended deletion set.

Do not clear the destination before uploading. Retention needs old assets to
remain present until both the generation and grace windows expire.

By default a mutating retention run serializes itself: it holds
`<historyDirectory>/.retention.lock`, and a concurrent run fails fast with
`RetentionLockError` (`code: ERR_RETENTION_LOCKED`). This guards one
distribution directory against overlapping retention, but it does not serialize
your upload or HTML publication step, so keep external deploy steps from
overlapping too. Pass `lock: false` (programmatic) only when you already
serialize runs.

For a custom Vite layout, and to prune the broader `vite` asset set:

```sh
vite-retain-assets \
  --dist public \
  --manifest build/manifest.json \
  --assets-dir static \
  --assets-base static \
  --history-dir .deploy-history \
  --history-limit 5 \
  --grace-hours 24 \
  --asset-preset vite \
  --dry-run
```

`--asset-preset vite` widens deletion to hash-suffixed Vite assets (images,
fonts, JSON, WebAssembly, source maps, media, and their `.br`/`.gz` siblings)
while still protecting current, retained, and unhashed files and honoring the
grace window; a compressed sibling stays protected while its manifest-listed
original is. It does not cover every plugin output — programmatic callers can
use a custom `assetPattern` when an emitted name does not fit a preset. Review
the dry run before dropping `--dry-run`.

Relative paths are resolved under the distribution directory, and absolute
paths must remain within it. The retention API rejects lexical or symbolic-link
escapes, an empty manifest, and missing current assets rather than treating
every old asset as unreferenced.

## Observe retention in production

`retainBuildAssets` returns `retainedGenerations`, `removableBytes`, and
`oldestRemovableAgeMs` alongside the deletion list, which is enough to alert on
runaway growth or an unexpectedly large prune. For step-by-step telemetry, pass
an `onEvent` callback: it reports lock acquisition/release, the `planned` set,
each `asset-removed`, and a `completed` summary. Callback exceptions are
swallowed, so instrumentation can never change what retention does. The browser
`onEvent` mirrors this for `reload` and `suppressed` recovery decisions. See the
[API reference](./api.md) for the exact fields.

## Recover open browser sessions

Install the browser controller before application code starts lazy loading:

```js
import { installViteRecovery } from "vite-deploy-continuity/recovery";

installViteRecovery();
```

Vite's `vite:preloadError` event is the primary signal. Generic browser error
listeners provide a fallback for recognized chunk-load messages. Recovery adds
a cache-busting query and reloads at most once within the configured time
window.

## Roll back

Republish the previous HTML and manifest. Do not remove the failed generation
until clients and edge caches have converged. If the required prior assets were
already removed, restore them from the deployment artifact or backup before
republishing the previous HTML.

## Staging checks

- Open the old version, deploy a new version, and trigger an old lazy route.
- Confirm that a retained chunk loads without a page reload.
- Remove that chunk in staging and confirm exactly one recovery reload.
- Confirm that `.br` and `.gz` responses have the original content type,
  correct `Content-Encoding`, and `Vary: Accept-Encoding`.
- Confirm that range requests are handled by the downstream static server.
- Confirm that HTML remains revalidated while versioned assets are immutable.
  If precompressed HTML is enabled through a custom extension list, configure
  its cache policy explicitly.
