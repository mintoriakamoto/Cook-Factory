# Source Ledger

Research sources for the Vault City companion essays. Humans own the prose
in this file; the keeper owns the fenced canon block and the Revisions log.
Every source carries a verbatim excerpt captured at ingest so later drafts
can anchor claims without refetching anything.

```yaml canon-facts
schema: canon-facts/v1
store: sources
sources:
  - id: reyes-2024-grid
    title: Grid Storage Economics 2024
    author: A. Reyes
    url: https://example.org/grid-2024
    access: live
    access_date: 2026-07-21
    excerpt: "Storage costs fell 89 percent between 2010 and 2023."
  - id: okafor-2019-tunnels
    title: Tunnel Networks of the Old Grid
    author: N. Okafor
    url: https://example.org/tunnels-2019
    access: archived
    content_hash: sha256:0f3a9c41d2
    access_date: 2026-07-20
    excerpt: "The old grid ran 3 levels below the street plate."
  - id: vault-city-charter
    title: Vault City Charter, Print Edition
    author: City Records Office
    access: offline
    access_date: 2026-07-19
    excerpt: "The charter grants the syndicates no title below level 2."
```

## Revisions

- 2026-07-23: ledger seeded with 3 sources covering live, archived, and offline access.
