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

## Test expectations

Retention changes must prove that current and retained manifest assets are
never deleted, the grace period is honored, and dry runs perform no writes.
Use an explicit clock and filenames in tests. Path changes must cover both
lexical traversal and symbolic-link escape.

Recovery changes should cover false positives and repeated failures as well as
the intended Vite error. Static-serving changes need path-containment,
content-negotiation quality, freshness, media-type, and cache-header cases.
Public API changes must update the matching `.d.ts` file and the consumer type
test.

## Safety constraints

Deletion must stay conservative and limited to the configured asset directory.
Do not broaden the default filename pattern without a clear migration and
regression tests. The browser helper may reload at most once for a given
recovery attempt. Hosting-provider integrations and deployment transport
belong outside the core package.

Report vulnerabilities using [SECURITY.md](./SECURITY.md). Contributions are
licensed under the repository's [MIT license](./LICENSE).
