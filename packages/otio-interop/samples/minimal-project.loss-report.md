# OTIO export loss report — project_demo_001 (rev 0)

- adapter: @agentcut/otio-interop@0.1.0
- OTIO (official library): 0.18.1
- exportedAt: 2026-09-06T11:41:02.720Z
- round-trip (via official parser): **equivalent**

| Category | Severity | Count | Detail |
|---|---|---:|---|
| artifact:deletionCandidateSet | dropped | 1 | 1 deletionCandidateSet artifact(s) are AgentCut workspace data, not timeline content |
| artifact:editProposal | dropped | 1 | 1 editProposal artifact(s) are AgentCut workspace data, not timeline content |
| artifact:transcript | dropped | 1 | 1 transcript artifact(s) are AgentCut workspace data, not timeline content |
| provenance-and-history | dropped | 1 | provenance, versions and history belong to the AgentCut audit domain, not to an interchange file |
