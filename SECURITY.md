# Security policy

## Supported versions

This is a pre-1.0 package. Only the latest published minor line, `0.2.x`,
receives security fixes; earlier minor lines in the `0.x` series are
unsupported. Reports should identify the affected version and, when it is safe
to test, say whether the issue reproduces on the latest `0.2.x` release.

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/seoulpro/vite-deploy-continuity/security/advisories/new).
That is the direct, primary channel. Do not disclose vulnerability details in
public issues.

The retention API deletes eligible files, the static helper resolves request
paths, and the browser helper reacts to page errors. Vulnerabilities in those
boundaries can affect deployed assets or application availability. Report
deletion outside the configured assets directory, path traversal, unsafe
content negotiation, cache-header confusion, reload loops, or recovery triggered
by unrelated errors.

Include the affected version, runtime and operating system, a minimal manifest
or request, the options in use, the impact, and a mitigation when known. Do not
attach production builds, server paths, or private URLs unless the private
report genuinely requires them.

We will review and respond to valid reports, but this project does not commit to
a fixed response or remediation timeline.

## Scope and boundaries

The default deletion pattern is intentionally narrow, but deployment operators
must still use `--dry-run`, retain backups, and choose generation and grace
windows appropriate for their cache lifetime. The package does not authenticate
requests, configure a CDN, or make a deployment atomic.

Retention paths are required to remain within the configured distribution
directory, including after symbolic-link resolution. The precompressed
middleware applies the same real-path boundary before rewriting a request.
Retention also refuses an empty manifest or missing current manifest assets,
which fails closed when a build or manifest publication is incomplete.
