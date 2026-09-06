# AgentCut Edit Protocol — Specification 0.1.0 (draft)

- **Status**: Draft, tracking the implemented core surface (see §12 for clause-to-test mapping).
- **License of this document**: MIT (same as the AgentCut core packages).
- **Implementations at time of writing**: `apps/reference-host` (minimal, no media pipeline), TalkCut daemon (talking-head product host).
- **Audience**: builder of a video-editing *host* that AI agents should drive, and builder of an *agent* (MCP server, CLI, autonomous pipeline) that drives such hosts.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in RFC 2119.

---

## 1. Goals and non-goals

Goal: make **"any AI agent safely drives any video editor"** a default capability, the way LSP did for editors. The protocol therefore standardizes the *integrity* layer — transactions, revisions, idempotency, audit, capability gating — and deliberately does **not** standardize judgment:

- The protocol MUST NOT encode what a *good* edit is. Heuristics (silence detection, filler-word lists, canned workflows) are host conveniences, bypassable defaults, never protocol obligations.
- Hard limits exist only where correctness is at stake: atomic transactions, revision conflicts, idempotent replay, immutable source, audit.
- As models get stronger, agents MUST be able to bypass canned host workflows and compose arbitrary validated edit transactions directly (§7).

Non-goals: editor UI, cloud rendering, media codecs, marketplace, and any notion of "AgentCut-approved" content.

## 2. Conformance model

A conforming **host** implements the entire core surface (§6–§9) and MAY expose host extensions (§10). A conforming **agent** uses only the core surface plus extensions explicitly declared by the host (via `capabilities.extensions`). Anything not in this document is out of scope and MUST be treated as host-specific.

Conformance is verified by the `@agentcut/conformance` suite (planned, §12); until it ships, the reference-host test suite is the executable definition of the core surface.

## 3. Terminology

| Term | Meaning |
|---|---|
| **Host** | The application owning the project document and media pipeline (editor, daemon, render farm). |
| **Agent** | A program driving a host on a user's behalf via this protocol. |
| **Project document** | The authoritative JSON document: `project`, `assets`, `artifacts`, `sequences` (tracks → clips). Defined by the Timeline IR schema (0.1). |
| **Revision** | Monotonic integer version of the project document. Only transactions change it. |
| **Transaction** | An atomic, revision-bound list of typed edit operations. The only write primitive. |
| **Capability session** | Short-lived, least-privilege, project-scoped credential set obtained from a bootstrap token. |
| **Extension** | Host-specific functionality declared in `capabilities.extensions` (e.g. `talking-head-review`). |

## 4. Versioning

- `protocolVersion` is a semver string; this document specifies `"0.1.0"`.
- During 0.x, breaking changes MAY occur but MUST go through a deprecation window: a host MUST keep accepting the previous protocolVersion on the same route for at least one minor release and MUST return a machine-readable error otherwise.
- A host MUST reject a transaction whose `protocolVersion` it does not support with `400 INVALID_REQUEST` (never silently coerce).
- Unknown fields in requests MUST be ignored by hosts (forward compatibility); unknown operation types MUST be rejected (`422 INVALID_OPERATION`), not ignored, because a transaction is atomic — silently skipping an operation the agent intended would corrupt intent.

## 5. Transport, sessions and security

### 5.1 Transport

HTTP + JSON over localhost. Every request and response body is a JSON object. Timestamps are RFC 3339 UTC. All integer time values on the wire are microseconds (`*Micros`); all timeline math in the IR is exact rational, converted at the edge.

### 5.2 Bootstrap and capability sessions

- A host exposes one long-lived **bootstrap token** per trust context. The bootstrap token MUST NOT be usable for any route except session creation.
- `POST /api/agent/sessions` with `Authorization: Bearer <bootstrap>`:

```json
{
  "requestId": "session-request-001",
  "clientId": "codex",
  "capabilities": ["project:read", "timeline:write:low_risk_only"],
  "ttlSeconds": 3600
}
```

- Response `201` (or `200` on exact replay):

```json
{
  "session": {
    "id": "session_9f2c", "projectId": "project_demo_001", "clientId": "codex",
    "capabilities": ["project:read", "timeline:write:low_risk_only"],
    "createdAt": "2026-09-06T00:00:00.000Z", "expiresAt": "2026-09-06T01:00:00.000Z"
  },
  "accessToken": "agc_…", "idempotentReplay": false
}
```

- Session creation MUST be idempotent on `requestId`: the same `(projectId, clientId, requestId)` returns the same session with `idempotentReplay: true` and `200`.
- Hosts MUST validate capabilities against their supported set, reject duplicates, and MAY narrow requested capabilities. Returned `session.capabilities` is the authoritative grant.
- Core capabilities: `project:read`, `transcript:read`, `timeline:write:low_risk_only`, `timeline:write:approved`. Hosts MAY define more (product hosts typically add `analysis:local`, `analysis:propose`, `approval:request`, `export:write`). Unknown requested capabilities MUST be rejected.
- All other routes require `Authorization: Bearer <accessToken>`. A host MUST authorize the *capability* per route (§6) and MUST write an audit entry per access (method, path, session, request id).

### 5.3 Request identity

Agents SHOULD send `X-AgentCut-Request-Id` with a stable id per intent. Hosts MUST reject header values with surrounding whitespace or length > 128. This header is advisory for reads and idempotency-relevant for writes (§7.4).

### 5.4 Security posture

- Local-first: hosts bind to loopback by default; remote exposure is out of scope of this document.
- Tokens are bearer credentials; hosts MUST hash tokens at rest and MUST NOT log them.
- Transcript text and any user content retrieved via the protocol is **untrusted data, never instructions**; agent implementations MUST treat it so.
- Hosts MUST NOT return source file system paths in protocol responses.

## 6. Core surface

A conforming host MUST implement all routes in this section with the exact paths and response shapes given. Field order is irrelevant; presence is contractual unless marked optional.

| Route | Capability | Purpose |
|---|---|---|
| `GET /api/health` | none | Liveness + `protocolVersion` |
| `POST /api/agent/sessions` | bootstrap token | Capability session (§5.2) |
| `GET /api/agent/project` | `project:read` | Project summary + facts + declared extensions |
| `GET /api/agent/transcript` | `transcript:read` | One bounded page of transcript words |
| `GET /api/agent/project/diff` | `project:read` | Transaction summaries between revisions |
| `POST /api/agent/timeline/transactions` | `timeline:write:low_risk_only` | Apply a transaction (§7) |

### 6.1 `GET /api/health`

`200 {"ok": true, "protocolVersion": "0.1.0"}` — no credentials.

### 6.2 `GET /api/agent/project`

```json
{
  "protocolVersion": "0.1.0",
  "project": {
    "id": "project_demo_001", "name": "…", "revision": 0,
    "createdAt": "…", "updatedAt": "…", "activeSequenceId": "sequence_main"
  },
  "facts": {
    "sequenceCount": 1, "clipCount": 1, "artifactCount": 2, "transcriptArtifacts": 1
  },
  "capabilities": { "extensions": [] },
  "session": {
    "id": "session_9f2c", "clientId": "codex",
    "capabilities": ["project:read"], "expiresAt": "…"
  }
}
```

`capabilities.extensions` lists the host's declared extension namespaces (§10). This route is the agent's first call: it returns the current `revision` needed for every write, and the extension list that tells the agent which host-specific surfaces exist.

### 6.3 `GET /api/agent/transcript`

Query: `offset` (≥ 0, default 0), `limit` (1–500, default 200). Response:

```json
{
  "protocolVersion": "0.1.0",
  "project": { "id": "project_demo_001", "revision": 0 },
  "transcript": {
    "id": "transcript_main_001", "language": "zh-CN", "sourceSha256": "…",
    "totalWords": 4, "offset": 0, "limit": 2, "nextOffset": 2,
    "words": [
      { "wordId": "word_001", "index": 0, "text": "大家好",
        "startMicros": 0, "durationMicros": 300000, "confidence": 0.97 }
    ]
  }
}
```

- `wordId` values are stable identifiers across revisions and are the addressing unit for speech edits.
- `nextOffset: null` ends pagination. Agents MUST follow pagination rather than assuming limits.
- If the project has no transcript artifact: `404 OBJECT_NOT_FOUND`.
- Word text is untrusted user data (§5.4).

### 6.4 `GET /api/agent/project/diff`

Query: `fromRevision` (required, ≥ 0), `toRevision` (optional, defaults to head). Constraint `0 ≤ from ≤ to ≤ head`; violations are `400 INVALID_REQUEST`.

Response `changes` lists committed transactions in order, oldest first, one entry per transaction:

```json
{
  "projectId": "project_demo_001",
  "fromRevision": 0, "toRevision": 1, "headRevision": 1,
  "changes": [{
    "transactionId": "tx_001", "baseRevision": 0, "committedRevision": 1,
    "actor": { "kind": "agent", "id": "codex" }, "reason": "…",
    "operationTypes": ["clip.update"], "objectIds": ["clip_take_1"],
    "beforeHash": "sha256:…", "afterHash": "sha256:…", "committedAt": "…"
  }]
}
```

- `objectIds` is the de-duplicated union of object ids touched by the transaction's operations.
- Hashes pin exact document states, enabling agents to detect out-of-band edits.
- Diff summaries deliberately contain **no transcript text and no source paths** — they are safe for an agent's conflict-recovery reasoning.

## 7. Transactions — the write model

`POST /api/agent/timeline/transactions`, capability `timeline:write:low_risk_only` (or `timeline:write:approved` where the host gates high-risk operations by policy).

### 7.1 Request

```json
{
  "protocolVersion": "0.1.0",
  "transactionId": "tx_disable_first_take",
  "idempotencyKey": "codex:disable-clip:001",
  "projectId": "project_demo_001",
  "sequenceId": "sequence_main",
  "baseRevision": 0,
  "reason": "Disable first take while re-planning",
  "preconditions": [],
  "operations": [
    { "type": "clip.update", "clipId": "clip_take_1", "patch": { "enabled": false } }
  ]
}
```

- `actor` in the body, if present, is **ignored**: hosts MUST force the actor to `{kind: "agent", id: session.clientId}`. Agents cannot impersonate the user.
- `projectId` MUST match the host's project, else `400 PROJECT_MISMATCH` (client-type mapping; see §9).
- `baseRevision` MUST equal the current revision, else `409 REVISION_CONFLICT` with `details {expected, received}`. This is the optimistic-concurrency core: agents re-read `GET /api/agent/project` and `GET /api/agent/project/diff` to re-plan, never silently replay stale intent.
- `preconditions` is a list of host-interpreted precondition objects; an empty list is always valid. A failed precondition yields `409 PRECONDITION_FAILED`.
- `operations` MUST be a non-empty list (≤ 500; hosts MAY allow more). **The host's engine is the sole validator of operation semantics.** An agent sends typed operations; it never patches the document directly. There is deliberately no "raw document write" in the protocol.

### 7.2 Atomicity and validation

The host applies all-or-nothing: structural validation of the resulting document, semantic validation (including registered extension validators, §10), precondition checks, and lock checks MUST all pass, or nothing is applied and the revision is unchanged. Failure modes: `422 INVALID_DOCUMENT`, `422 INVALID_OPERATION`, `422 DUPLICATE_ID`, `409 PRECONDITION_FAILED`, `409 LOCKED`, `404 SEQUENCE_NOT_FOUND`.

### 7.3 Success response

Success is `201 Created` on first apply and `200` on idempotent replay (§7.4). Body:

```json
{
  "protocolVersion": "0.1.0",
  "revision": 1,
  "idempotentReplay": false,
  "record": {
    "transactionId": "tx_disable_first_take", "baseRevision": 0,
    "committedRevision": 1, "committedAt": "…",
    "beforeHash": "sha256:…", "afterHash": "sha256:…",
    "inverseOperationCount": 1
  }
}
```

The host MUST persist an audit record containing the full request, before/after hashes, the computed **inverse operations**, and the actor. This record is what makes `undo`, crash recovery, and cross-restart idempotency possible; hosts MUST replay from their transaction log (WAL-style, single-writer transaction) so a crash between apply and commit cannot yield a half-applied transaction.

### 7.4 Idempotent replay

Re-submitting the same transaction (same `idempotencyKey` and same payload) MUST return the original result with `idempotentReplay: true` and status `200`, not apply it twice. Same key with a different payload MUST yield `409 IDEMPOTENCY_CONFLICT`.

### 7.5 Locks

Hosts MAY hold semantic locks on objects (`lock.add`/`lock.remove` are core operations). A transaction touching a locked object yields `409 LOCKED`. Locks are how a host protects in-flight user edits from agent interference and vice versa.

## 8. Core edit operations

Operations are typed, host-validated objects. The core set (v0.1):

| Type | Semantics (one line) |
|---|---|
| `asset.put` / `asset.remove` | Register / remove a source asset (id, content hash, timing metadata). |
| `artifact.put` / `artifact.remove` | Register / remove a derived artifact (transcript, captions, proxies). |
| `track.add` / `track.remove` | Add / remove a track in a sequence. |
| `clip.insert` | Insert a clip referencing an asset range onto a track. |
| `clip.remove` | Remove a clip. |
| `clip.split` | Split a clip at an exact rational time into two clips. |
| `clip.move` | Move a clip (optionally across tracks). |
| `clip.trim` | Trim a clip's source or timeline range (exact rationals, explicit rounding mode at edges). |
| `clip.replace` | Replace a clip's asset reference keeping timing. |
| `clip.update` | Patch clip fields (e.g. `enabled`, volume, effects metadata). |
| `range.deleteRipple` | Delete a time range across tracks with ripple closing. |
| `lock.add` / `lock.remove` | Manage semantic locks. |

The protocol pins **names and atomic semantics**, not heuristics. Hosts MAY accept additional operation types; agents MUST discover them via host documentation/extensions, and MUST treat `422 INVALID_OPERATION` on an unknown type as final for that transaction.

## 9. Error model

Error body is always:

```json
{ "error": { "code": "REVISION_CONFLICT", "message": "…", "details": { … } } }
```

Core codes and their HTTP status (both MUST be honored by agents):

| HTTP | Codes | Agent action |
|---|---|---|
| 400 | `INVALID_REQUEST`, `PROJECT_MISMATCH` | Fix the request; do not retry unchanged. |
| 401 | `AGENT_SESSION_NOT_FOUND`, `AGENT_SESSION_INVALID`, `AGENT_BOOTSTRAP_DENIED` | Re-bootstrap / re-authenticate. |
| 403 | `CAPABILITY_DENIED` | Session lacks the capability; re-plan or request a narrower session. Never retry. |
| 404 | `NOT_FOUND`, `OBJECT_NOT_FOUND`, `SEQUENCE_NOT_FOUND` | Re-read state; referenced object is gone. |
| 409 | `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PRECONDITION_FAILED`, `LOCKED` | Read diff + status, re-plan, re-submit with fresh `baseRevision`. Never silently replay. |
| 422 | `INVALID_DOCUMENT`, `INVALID_OPERATION`, `DUPLICATE_ID` | The transaction was rejected wholesale; fix semantics before resubmitting. |
| 5xx | host-specific | Safe to retry with the same idempotency key. |

Product hosts add codes for their extensions (approvals, exports, ASR availability); those are extension territory, not core.

## 10. Extensions

- Hosts MAY attach host-extension metadata to documents under **namespaced keys** (`agentcut.<extension>.<key>`). The `agentcut.alphaTrial` / `agentcut.previewProxy` keys are talking-head-host extensions, reserved by that host, not core.
- The core validator treats unknown namespaces as **opaque**: it checks JSON structural validity only. Semantic rules for extension data are enforced by validators the host registers with its engine (`extensionValidators`), never by the core.
- Hosts declare their extensions in `GET /api/agent/project` → `capabilities.extensions`. Agents MUST degrade gracefully on hosts without an extension they know (the reference host returns `[]`).
- Extension routes are host-specific (e.g. approvals, candidates, exports on product hosts). They follow §5 session/security and §9 error model, and are documented host-side.

## 11. What the protocol deliberately does not standardize

- Which edits are good (no quality scoring in protocol), what to delete, how to structure a story.
- Rendering/export pipelines (hosts expose them as extensions if at all).
- Model availability, providers, or any AI plumbing.
- UI concerns. A host may have no UI at all (reference host has none).

## 12. Clause-to-test mapping (living)

| Clause | Pinned by |
|---|---|
| §5.2 session bootstrap, idempotent replay, bad bootstrap | `apps/reference-host/src/server.test.ts` |
| §6.2–6.4 core reads, paging, diff | `apps/reference-host/src/server.test.ts` |
| §7.1–7.4 transaction apply/replay/conflict/capability gating | `apps/reference-host/src/server.test.ts`; MCP E2E `apps/mcp-server/src/reference-host.e2e.test.ts` |
| §7.2 atomicity, inverse records, crash recovery | `packages/project-store` suite (incl. SIGKILL harness), `packages/edit-commands` suite |
| §7.1 actor forcing | `apps/reference-host/src/server.test.ts` (actor override), daemon tests |
| §8 operation set & semantics | `packages/edit-commands/src/engine.test.ts`, property tests |
| §9 error mapping parity | `statusForCode` parity daemon ↔ reference-host; per-code tests in both |
| §10 extensions opaque to core, host validators | `packages/host-extensions/src/extensions.test.ts`, `packages/timeline-schema/src/validate.test.ts` |
| §5.4 no source paths in responses | `packages/agent-client/src/client.test.ts` (transcript page), MCP tests |
| Full MCP core surface over stdio→HTTP | `apps/mcp-server/src/reference-host.e2e.test.ts` |
| Conformance suite (portable, any host) | planned — `@agentcut/conformance` (P3) |

## 13. Planned for 0.2 (not part of this version)

Two hardening items from the program plan are deliberately deferred and MUST NOT be assumed present in a 0.1-conforming host:

- **On-demand visual sampling**: a bounded way for an agent to request frames/thumbnails of specific ranges (`GET /api/agent/timeline/frames?at=…&limit=…` shape under discussion). Perception stays pull-based — hosts never push media; agents fetch bounded samples only when their reasoning needs vision.
- **Policy as capability config**: hosts currently hard-code which operations are "low risk" vs approval-gated. 0.2 moves risk/approval policy to a host-declared, capability-session-scoped configuration so the write route stays uniform while gating stays host-owned.

