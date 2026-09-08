# Security Policy

## Scope and trust model

AgentCut is **local-first**: hosts bind to `127.0.0.1`, bootstrap tokens live
on your machine, and agent access is granted through scoped, expiring,
revocable capability sessions. The reference host is a minimal implementation
meant for local use, CI, and conformance testing — it is not a hardened
multi-user server.

Out of scope by design (do not file reports about these): running the
reference host on a public interface; multi-tenant operation; malicious media
files (media integrity is the host's domain); prompt injection inside an
agent's own reasoning.

What the protocol guarantees: atomic transactions, revision-bound optimistic
concurrency, idempotent retries, host-enforced actor attribution,
capability-gated routes, and revocation that survives restarts. What it does
not promise: sandboxing of arbitrary agent code, cryptographic protection of
local data at rest, or defense against a compromised host process.

## Reporting a vulnerability

This repository is pre-public-release (0.x). Please report vulnerabilities
privately:

- Preferred: GitHub **private vulnerability reporting** on this repository
  once it is published.
- Until then, contact the maintainers directly (repository owner) rather than
  opening a public issue.

Please include a minimal reproduction and the affected surface (route, MCP
tool, or package). We will acknowledge within a week of a report arriving and
coordinate disclosure with you.

## Supported versions

| Version | Status |
|---|---|
| 0.1.x (protocol + packages) | In development — fixes land on the main branch |

0.x releases make no API stability promises; see
[docs/protocol/versioning.md](./docs/protocol/versioning.md) for the
deprecation-window policy that does apply.

## Known limitations (honest list)

- The demo bootstrap token printed by `pnpm quickstart` is for a localhost
  demo project only; do not reuse it elsewhere.
- `apps/local-daemon` / `apps/studio` are product-era snapshot code being
  split out; their security properties are documented in the development log
  and are not part of the protocol conformance surface.
- The OTIO adapter writes media file references into exported files; treat any
  `.otio` export as revealing your project's file layout.
