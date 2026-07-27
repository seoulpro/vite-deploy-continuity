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
- [ ] Only one retention process runs per distribution directory.

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

- **Default deletion is narrow on purpose.** Only generated `.js` and `.css`
  files are eligible for deletion. Other emitted asset types — images, fonts,
  JSON, WebAssembly, source maps — are never pruned by default, so they can
  accumulate. Removing them requires an explicitly reviewed custom
  `assetPattern`; widen it deliberately and test it against a dry run, because
  the pattern is the last guard against deleting a still-referenced file.
- **One retention process per directory.** History writes are atomic, but the
  package provides no cross-process lock. Serialize retention so two deploys do
  not prune the same distribution directory at once.
- **Service workers are a separate cache generation.** A service worker adds its
  own precache and update lifecycle on top of HTTP caches. This package does not
  manage service workers; stage and test the worker's update and skip-waiting
  behavior as part of the application so it does not pin clients to assets this
  package has pruned.
- **`?v=` must identify immutable content.** The static cache helper treats a
  request as immutable when the configured version parameter (`v` by default)
  carries any non-empty value, sending `max-age=31536000, immutable`. Use it
  only for a value that changes whenever the bytes change — a content hash or
  build id — never for arbitrary request state such as a session or tracking
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

Run only one retention process for a distribution directory at a time. History
writes are atomic, but the package does not provide a cross-process deployment
lock.

For a custom Vite layout:

```sh
vite-retain-assets \
  --dist public \
  --manifest build/manifest.json \
  --assets-dir static \
  --assets-base static \
  --history-dir .deploy-history \
  --history-limit 5 \
  --grace-hours 24 \
  --dry-run
```

Relative paths are resolved under the distribution directory, and absolute
paths must remain within it. The retention API rejects lexical or symbolic-link
escapes, an empty manifest, and missing current assets rather than treating
every old asset as unreferenced.

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
