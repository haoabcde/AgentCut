# OTIO export loss report — project_otio_roundtrip_10min (rev 0)

- adapter: @agentcut/otio-interop@0.1.0
- OTIO (official library): 0.18.1
- exportedAt: 2026-09-06T11:41:02.842Z
- round-trip (via official parser): **equivalent**

| Category | Severity | Count | Detail |
|---|---|---:|---|
| clip-stream-index | metadata-encoded | 3 | clip clip_a_001: OTIO media references carry no stream index; encoded as metadata; clip clip_a_002: OTIO media references carry no stream index; encoded as metadata; clip clip_a_003: OTIO media references carry no stream index; encoded as metadata |
| disabled-clip | metadata-encoded | 2 | clip clip_v_003: OTIO has no enabled flag; encoded as metadata, invisible to NLEs; clip clip_a_003: OTIO has no enabled flag; encoded as metadata, invisible to NLEs |
| non-media-clip | dropped | 1 | clip clip_v_shape (shape): exported as gap to preserve timing |
| provenance-and-history | dropped | 1 | provenance, versions and history belong to the AgentCut audit domain, not to an interchange file |
| sequence-locks | dropped | 1 | 1 lock region(s) are AgentCut access-control semantics, not timeline content |
| track-flags-metadata | metadata-encoded | 1 | track track_a1: locked/enabled/muted are AgentCut semantics, encoded as metadata |
| unmappable-marker | dropped | 1 | marker without {name: string, start: IR time} shape has no OTIO equivalent |
