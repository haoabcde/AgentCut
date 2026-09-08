# Contributing

AgentCut is the open protocol project for AI-driven video editing: a versioned
timeline IR, a command protocol, a reference host, and a conformance suite
(MIT). The short version of this document: **the protocol spec and the
conformance suite lead; code follows.**

## Scope discipline

We deliberately do not build: an editor UI, cloud hosting, accounts, a 1.0
release, or a long list of tools (protocol value is semantic correctness, not
method count). See `docs/19-protocol-program-plan.md` §5. PRs that expand
scope beyond this are likely to be declined not on quality but on mission.

## Development setup

Requirements: Node.js ≥ 20, pnpm ≥ 9, git. Optional: Python 3 with
`pip install --user opentimelineio` (OTIO adapter tests), FFmpeg (media
suites).

```bash
pnpm install
pnpm build
CI=true AGENTCUT_FFMPEG_PATH=/path/to/ffmpeg pnpm check   # build + typecheck + all tests
```

`pnpm check` must exit 0 before any commit. `pnpm quickstart` gives you a
local reference host with a demo project for manual exploration.

## Changing the protocol

Protocol-surface changes (routes, transaction semantics, error model, schema)
require, in order:

1. **Spec first.** Update `docs/protocol/agentcut-protocol-0.1.md` (or open a
   new versioned draft). Every normative clause must be testable.
2. **Conformance suite second.** Add or adjust checks in
   `packages/conformance` and update the §12 clause↔test mapping in the spec.
   Both reference hosts (reference host + local daemon) must pass.
3. **Versioning policy.** 0.x changes may be additive without ceremony;
   breaking changes require the deprecation window defined in
   [docs/protocol/versioning.md](./docs/protocol/versioning.md). Add a
   changeset (`pnpm changeset`) for kernel-package changes.
4. **Only-add when possible.** The 0.1 surface has been kept strictly
   additive; review whether your goal can be met without breaking clients.

## Integrity invariants (do not weaken)

These are pinned by tests; a PR that changes them needs explicit justification
in the description:

- `ProjectStore.commit` checks the idempotency key **before** the base
  revision (replays must return the original outcome even with a stale
  revision).
- Hosts force the recorded actor to the session identity; request-supplied
  actors are ignored.
- Transactions apply atomically; partial application is impossible, including
  under mixed valid/invalid operations.
- Time semantics: IR `seconds = value · denominator / numerator`.
- The conformance suite may only mark a check skipped for declared reasons
  (`host-content`, `no-controller`, `prerequisite`), and the first two require
  explicit allowance or the verdict fails.

## License hygiene

The kernel is MIT. Dependencies must not be AGPL/GPL. When adapting ideas from
other projects, prefer clean-room reading of their specs/behavior over copying
code.

## Commit discipline

- One logical change per commit; the commit message states what changed and
  why.
- `docs/11-development-log.md` gets an entry for every landed change — what is
  now a verified fact, what remains open. Honest reporting is a hard rule:
  failed tests are reported as failures, never smoothed over.
- Adversarial self-review before requesting merge: what is the most likely way
  this breaks that the tests didn't catch?
