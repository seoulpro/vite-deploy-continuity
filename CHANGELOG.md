# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 - 2026-07-28

### Added

- Retention observability: `retainBuildAssets` now also returns
  `retainedGenerations`, `removableBytes`, `oldestRemovableAgeMs`, and
  `assetPolicy`, and accepts an `onEvent` callback that emits `lock-acquired`,
  `lock-released`, `planned`, `asset-removed`, and `completed` events. Callback
  exceptions are swallowed so telemetry cannot change retention behavior.
- Recovery observability: recovery options accept an `onEvent` callback that
  emits `reload`, `suppressed`, and `query-cleared` events, with callback
  exceptions swallowed so instrumentation cannot cause or prevent a reload.
- Cross-process retention lock: a mutating run acquires
  `<historyDirectory>/.retention.lock` by exclusive file creation and fails fast
  with the exported `RetentionLockError` (`code: "ERR_RETENTION_LOCKED"`) when a
  concurrent run holds it. Configurable through `lock`, `lockPath`,
  `lockStaleMs`, and the CLI `--lock-stale-minutes` (default 60); dry runs stay
  write-free and take no lock. This serializes retention processes only and does
  not make the asset/HTML deployment atomic.
- Opt-in `vite` asset preset (`assetPreset` / `--asset-preset code|vite`) that
  extends deletion eligibility to hash-suffixed common Vite assets — images,
  fonts, JSON, WebAssembly, source maps, media, and `.br`/`.gz` siblings — while
  keeping current, retained, and unhashed files protected. `assetPreset` and a
  custom `assetPattern` are mutually exclusive; `code` remains the default.
- Safer immutable cache classification: `CacheControlOptions` accepts a mutually
  exclusive `versionPattern` (`RegExp`) or `isVersioned(url)` predicate to
  validate that a request is genuinely versioned before the immutable policy is
  applied.
- Real-browser end-to-end tests (`npm run test:e2e`) that build two Vite
  generations and verify both retained-chunk loading without a reload and a
  single recovery reload after pruning, with a dedicated Node.js 24 / Chromium
  CI job.

## 0.1.0 - 2026-07-28

Initial release.

### Added

- Conservative asset-retention API and CLI for Vite manifests, with bounded
  generation history, a minimum-age grace period, dry runs, custom output
  paths, atomic collision-safe history writes, current-asset validation, and
  lexical plus real-path containment checks.
- Browser recovery controller for Vite preload errors and common stale dynamic
  import failures, with session and URL-marker protection against reload loops.
- Connect/Express-compatible middleware for fresh Brotli and gzip siblings,
  quality-aware content negotiation, correct content types for common Vite
  assets, root containment, version-aware cache headers, and range-request
  pass-through.
- ESM subpath exports and TypeScript declarations for the complete public API.
- Unit, CLI, package-consumer, type-surface, coverage, and public archive
  verification.
- GitHub Actions CI across supported Node.js release lines.
