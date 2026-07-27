# Deployment guide

`vite-deploy-continuity` reduces version-skew failures; it does not make a
multi-step deployment atomic. Use immutable, content-hashed asset URLs and
serve HTML with `Cache-Control: no-cache`.

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
