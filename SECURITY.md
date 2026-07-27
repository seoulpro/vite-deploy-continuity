# Security policy

The retention API deletes eligible files, the static helper resolves request
paths, and the browser helper reacts to page errors. Vulnerabilities in those
boundaries can affect deployed assets or application availability.

Use the repository's private vulnerability reporting feature for deletion
outside the configured assets directory, path traversal, unsafe content
negotiation, cache-header confusion, reload loops, or recovery triggered by
unrelated errors. If private reporting is unavailable, open a detail-free issue
and request a private channel.

Include the affected version, runtime and operating system, minimal manifest or
request, options, impact, and a mitigation when known. Do not attach production
builds, server paths, or private URLs unless the private report requires them.

The default deletion pattern is intentionally narrow, but deployment operators
must still use `--dry-run`, retain backups, and choose generation and grace
windows appropriate for their cache lifetime. The package does not authenticate
requests, configure a CDN, or make a deployment atomic.

Retention paths are required to remain within the configured distribution
directory, including after symbolic-link resolution. The precompressed
middleware applies the same real-path boundary before rewriting a request.
Retention also refuses an empty manifest or missing current manifest assets,
which fails closed when a build or manifest publication is incomplete.
