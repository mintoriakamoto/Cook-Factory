---
template: software
status: captured
---

# Brainstorm: offline sync engine

**Date:** 2026-07-23

## Context

Users lose edits on flaky connections; the team wants sync that survives
offline stretches without a merge headache. Came out of 2 support threads
and a parked idea from the last milestone.

## Options Considered

### Server-authoritative sync

Simple mental model, but every offline edit risks a rejection on reconnect.
Rejected: the whole point is protecting offline work.

### Local-first CRDT store

Edits merge without coordination; the tradeoff is library maturity and
storage overhead. This carried the session.

## Recommendation

Local-first CRDT store, desktop first. The runner-up (server-authoritative
with an offline queue) stays in reserve if CRDT benchmarks disappoint.

## Decisions

- Sync engine uses a local-first CRDT store (stance: guided, confirmed at exit)
- Conflict resolution surfaces to the user only on schema conflicts (stance: sounding-board, confirmed at exit)
- The first release targets desktop only (stance: generative, confirmed at exit)
- We should probably use WebRTC for the transport layer

## Notes

- Maybe the CRDT store could also back the plugin system someday
- Leaning toward a weekly release cadence but nothing settled
- Mobile might matter sooner than we think if the pilot lands

## Open Questions

- Which CRDT library to adopt; a benchmark on 100k-row documents would answer it
- How schema migrations replicate across devices; a spike would answer it

## Next Step

Run /ferrox:new-project with this artifact as intake.
