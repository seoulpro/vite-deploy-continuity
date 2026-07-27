# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
