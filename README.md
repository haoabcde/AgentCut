[English](./README.md) | [中文说明](./README.zh-CN.md)

# AgentCut

> **North star:** make "any AI agent safely drives any video editor" an industry
> default capability. AgentCut is an attempt at the open standard for that — the
> way the Language Server Protocol is for programming languages.

**AgentCut is a timeline IR + command protocol + reference host + conformance
suite for AI-driven video editing.** It is local-first and MIT-licensed.
External agents (Claude Code, Codex, any MCP client, or plain HTTP clients)
connect to a host; the host owns its editor and media pipeline. The protocol
enforces what integrity requires — atomic transactions, optimistic concurrency,
idempotent retries, capability-scoped sessions, audit records — and deliberately
does *not* encode what judgment requires (no "what a good cut is").

Status: protocol **v0.1** (0.x, no 1.0 until a second independent host
implementation exists). Spec: [`docs/protocol/agentcut-protocol-0.1.md`](./docs/protocol/agentcut-protocol-0.1.md).

## Quickstart (3 minutes, after clone+build)

```bash
git clone <this-repo> agentcut && cd agentcut
pnpm install && pnpm build
pnpm quickstart
```

`pnpm quickstart` seeds a demo project, starts the **reference host** on
`127.0.0.1:4318`, and prints everything you need:

- a ready-made **MCP config** (also written to `.agentcut-quickstart/mcp.json`)
  for Claude Code / Claude Desktop / Codex — connect a client and ask it, in
  your own words, to disable clip `"clip_take_1"`; it will read the project,
  discover the timeline, commit one atomic transaction, and confirm it in the
  diff (host-side acceptance: revision 0 → 1, exactly one diff change);
- a **plain-HTTP walkthrough**: exchange the bootstrap token for a scoped
  expiring session (`POST /api/agent/sessions`), read the project
  (`GET /api/agent/project`), discover edit targets
  (`GET /api/agent/timeline`), commit one atomic transaction
  (`POST /api/agent/timeline/transactions` with `baseRevision` +
  `idempotencyKey`), and review the change (`GET /api/agent/project/diff`).

## How it fits together

```
AI agent (MCP / HTTP)                    host (owns editor + media)
  ├─ bootstrap token ──────────────►  session with scoped capabilities + TTL
  ├─ project/timeline/transcript ◄──  discoverable read surface (no paths/URLs)
  ├─ transaction ──────────────────►  validated atomically against baseRevision
  ├─ diff (afterHash chain) ◄───────  review what changed, driven by whom
  └─ idempotent replay ────────────►  unknown outcomes are safe to retry
```

Design commitments, each backed by tests and by the [conformance suite](./packages/conformance/README.md):

- **Revision-bound, idempotent writes.** `store.commit` checks the idempotency
  key *before* the base revision, so a replayed request returns the original
  outcome even when its revision has gone stale. Conflicting payloads under the
  same key are rejected (`IDEMPOTENCY_CONFLICT`).
- **Actor forcing.** Hosts ignore the `actor` field in requests and record the
  session identity; agents cannot spoof attribution.
- **Capability gating.** Reads need `project:read`/`transcript:read`; timeline
  writes need the host-declared write-policy capability
  (`timeline:write:low_risk_only` on the reference host).
- **Machine-readable errors, one error model.** Same shapes across reference
  host and any conforming daemon.
- **Portability.** The IR is the truth source; OTIO is a boundary format with an
  honest [loss report](./packages/otio-interop/README.md) (dropped vs
  metadata-encoded) and self-verifying round-trips. No NLE, framework, or media
  pipeline is privileged.

## Repository layout

| Path | What it is |
|---|---|
| `packages/timeline-schema` | Versioned Timeline IR (schema + types + migration) |
| `packages/edit-commands`, `packages/timeline-engine` | Command semantics and projection engine |
| `packages/project-store` | Durable store: SQLite WAL, transactions, idempotency, crash recovery |
| `apps/reference-host` | Minimal conforming host for the agent protocol (`REFERENCE_HOST_*` env) |
| `apps/mcp-server` | MCP stdio server (16 tools) fronting any conforming host |
| `packages/agent-client` | Typed TypeScript client |
| `packages/conformance` | **Portable conformance suite** — 23 checks mapped to spec clauses, CLI + library, machine-readable report |
| `packages/otio-interop` | OTIO boundary adapter (export-first, official OpenTimelineIO library) |
| `apps/local-daemon`, `apps/studio`, product packages | Product-layer snapshot from the pre-pivot project, being split out; see the [Chinese README](./README.zh-CN.md) |

## Verifying a host implementation

```bash
pnpm quickstart &                                   # or run any conforming host
AGENTCUT_CONFORMANCE_URL=http://127.0.0.1:4318 \
AGENTCUT_BOOTSTRAP_TOKEN=<token> \
  agentcut-conformance --report report.json
```

23 checks cover sessions, strict validation, reads, transactions (apply /
replay / conflict ordering / atomicity / unknown objects / capability gating /
actor forcing / protocol version), diff, the error model, and crash recovery
(with a host restart controller). Verdict and per-clause results land in
`report.json`. The suite is also embeddable as a library for host CI.

## Documentation

Protocol core (English):

- [Agent editing protocol spec v0.1](./docs/protocol/agentcut-protocol-0.1.md) — the contract
- [ADR-001: internal IR, not OTIO](./docs/protocol/adr-001-internal-ir-not-otio.md)
- [Versioning & deprecation policy](./docs/protocol/versioning.md)
- [@agentcut/conformance](./packages/conformance/README.md) — what "conforming" means, check by check
- [@agentcut/otio-interop](./packages/otio-interop/README.md) — IR ↔ OTIO mapping and loss taxonomy

Program and history (Chinese):

- [docs/19 — protocol program plan](./docs/19-protocol-program-plan.md) (P0–P6, gates, status)
- [docs/20 — AgentCut vs OpenChatCut](./docs/20-agentcut-vs-openchatcut.md) (clone-verified comparison, zh)
- [docs/18 — strategy review 2026-09](./docs/18-strategy-review-2026-09.md) (positioning, competitors)
- [docs/11 — development log](./docs/11-development-log.md) (verified facts, in order)
- [GOAL.md](./GOAL.md) — long-horizon agent mandate
- Full product-era index: [中文文档目录](./README.zh-CN.md)

## Development

```bash
pnpm check        # build + typecheck + all tests (FFmpeg path env for media suites)
pnpm e2e:agent    # real Claude Code / Codex MCP sessions against a live reference host
```

CI-representative invocation: `CI=true AGENTCUT_FFMPEG_PATH=<ffmpeg> pnpm check`.

## Security

Local-first by construction: hosts bind to loopback, bootstrap tokens stay on
your machine, sessions are scoped and revocable. See
[SECURITY.md](./SECURITY.md) for reporting and the trust model. This repository
has not yet been publicly released — security posture is still 0.x.

## License

[MIT](./LICENSE).
