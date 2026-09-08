# Release announcement draft (P5 material — DO NOT PUBLISH)

> Status: draft for maintainer review. Publishing (repo → public, first tag,
> announcement) requires explicit user confirmation per GOAL.md. The repository
> URL and tag are placeholders. An accompanying Chinese version will follow the
> approved English text.

---

# AgentCut: an open protocol so any AI agent can safely drive any video editor

Every AI-capable video editor today invents its own private agent surface:
one-off MCP tools, undocumented semantics, no way to verify that an agent is
safe to use against a given host, and no way for a new editor to adopt the
ecosystem without starting from zero. Agents are prompt-engineered per product.
Nothing composes.

We think this needs what programming languages got from the Language Server
Protocol: a **small, documented, testable protocol** that separates "the agent"
from "the editor". So we built AgentCut and are releasing it under MIT.

## What AgentCut is

- **A versioned Timeline IR** — a JSON-schema'd, rationally-timed data model
  with explicit migration, so clips, tracks, markers and provenance outlive
  any single tool.
- **A command protocol (v0.1)** — bootstrap-token sessions with scoped,
  expiring, revocable capabilities; a discoverable read surface
  (project / timeline / transcript); atomic, revision-bound, idempotent
  transactions; a content-hashed diff for reviewing exactly what an agent
  changed and under which identity; one machine-readable error model.
- **A reference host** — a minimal conforming implementation against a real
  SQLite store, with crash recovery.
- **An MCP server** — 16 tools that front any conforming host, so Claude Code,
  Codex, or any MCP client can drive it today.
- **A conformance suite** — 23 checks mapped clause-by-clause to the spec,
  runnable by anyone against any host, producing a machine-readable report.
  "Conforming" is a test result, not a claim.
- **An OTIO boundary adapter** — export to OpenTimelineIO through the official
  library, with an honest loss report (what was dropped vs what is
  metadata-encoded) and self-verifying round-trips.

What the protocol deliberately does **not** do: encode "what a good cut is".
Heuristics stay in tools, bypassable and replaceable — the protocol guards
integrity (transactions, idempotency, revisions, audit), not taste.

## Evidence, not vibes

- 479/479 tests in CI (`pnpm check`; the 3 OTIO round-trip integration tests
  skip honestly where `opentimelineio` is not installed).
- The conformance suite passes 25/25 against two independent host
  implementations (reference host and a local daemon) — including a
  crash-and-recover scenario with a real process restart.
- Real end-to-end sessions: Claude Code (50.8 s) and Codex (57.2 s) each drove
  a live reference host through MCP — read project → discover timeline →
  commit an atomic edit → confirm the diff — with acceptance checked against
  host state, not the agent's self-report.
- The 10-minute-scale OTIO round-trip is verified equivalent, and tampering
  with an exported file is detected rather than silently accepted.

## How it compares

OpenChatCut is the closest project — a strong open-source AI editor whose
external MCP surface shares many engineering instincts with AgentCut (draft
isolation, atomic approval, revision concurrency, idempotent recovery). We
cloned it and compared clause by clause with source citations
([docs/20](./docs/20-agentcut-vs-openchatcut.md)): its protocol is its
product's API — no standalone IR spec, no JSON Schema for its timeline, no
published conformance kit for third-party hosts, no protocol versioning, and
AGPL licensing. AgentCut occupies the layer below: editor-agnostic protocol +
reference host + conformance, MIT.

## Try it in 15 minutes

```bash
git clone <REPO_URL> agentcut && cd agentcut
pnpm install && pnpm build
pnpm quickstart
```

`pnpm quickstart` seeds a demo project and starts the reference host on
`127.0.0.1:4318`. Connect any MCP client with the printed config and ask it to
disable a clip — or follow the printed plain-HTTP walkthrough
(bootstrap → session → read → transaction → diff). Then point the conformance
suite at any host you build.

## 0.x honesty

The spec is v0.1: additive changes need no ceremony, breaking changes follow a
published deprecation policy, and there is no 1.0 until a second independent
host implementation exists. The repository still contains product-era snapshot
code being split out; the protocol core (schema, store, reference host, MCP
server, conformance, OTIO adapter) is the maintained surface.

Links: spec · conformance guide · OTIO adapter guide · full docs index
<!-- placeholders: fill repository URL, tag, and doc links on publish -->
