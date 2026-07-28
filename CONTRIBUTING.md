# Contributing to vite-deploy-continuity

Contributions are welcome across the retention CLI, browser recovery
controller, and static-serving helpers. Open an issue before changing deletion
eligibility, reload-loop protection, or cache-header defaults.

## Development

Use Node.js 22 or newer:

```sh
npm ci
npm run verify
```

The package has no runtime dependencies. Tests use temporary build directories
and do not need a Vite application. `npm run check` remains a dependency-free
syntax and unit-test loop; `npm run verify` is the release gate and also checks
coverage, declarations, package metadata, and an installed tarball.

The real-browser end-to-end suite is separate from both. It builds two real Vite
generations and drives Chromium, so it needs the dev dependencies and a browser:

```sh
npx playwright install chromium
npm run test:e2e
```

## Test expectations

Retention changes must prove that current and retained manifest assets are
never deleted, the grace period is honored, and dry runs perform no writes.
Use an explicit clock and filenames in tests. Path changes must cover both
lexical traversal and symbolic-link escape.

Retention changes that touch the cross-process lock, the `code`/`vite` asset
presets, or the `onEvent` telemetry must prove that a held lock fails fast, that
each preset still protects current, retained, and unhashed assets, and that a
throwing `onEvent` callback never alters the deletion outcome.

Recovery changes should cover false positives and repeated failures as well as
the intended Vite error, and prove that a throwing `onEvent` callback cannot
cause or prevent a reload. Static-serving changes need path-containment,
content-negotiation quality, freshness, media-type, and cache-header cases,
including `versionPattern`/`isVersioned` classification of versioned and
unversioned requests. Public API changes must update the matching `.d.ts` file
and the consumer type test.

## Safety constraints

Deletion must stay conservative and limited to the configured asset directory.
`code` stays the default preset; the broader `vite` preset and any custom
`assetPattern` are opt-in and must keep current, retained, and unhashed assets
protected — do not broaden a default without a clear migration and regression
tests. The mutating retention lock defaults on and must fail fast rather than
race, without making deployment atomic. Observability callbacks must never
change retention or recovery behavior, even when they throw. The immutable cache
policy must not be applied to a request the configured predicate or pattern has
not confirmed as versioned. The browser helper may reload at most once within
the configured recovery window for a given attempt. Hosting-provider
integrations and deployment transport belong outside the core package.

Report vulnerabilities using [SECURITY.md](./SECURITY.md). Contributions are
licensed under the repository's [MIT license](./LICENSE).
