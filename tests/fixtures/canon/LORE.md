# Vault City Lore

This is the canon store for the Vault City serial. Humans own every prose
section in this file. The keeper owns exactly 1 thing here: the fenced
canon block below, plus the Revisions log at the bottom.

## World Notes

Vault City sits on a street plate above the old grid. The syndicates run
the levels below it, and the city charter pretends they do not. Nobody has
held a clear title to the Undervault since the door was sealed in 2859.

## Voice

Keep the narration close and dry. Let the city talk through signage,
ledgers, and locked doors rather than exposition.

```yaml canon-facts
schema: canon-facts/v1
store: lore
entities:
  - id: mara-vale
    type: character
    name: Mara Vale
    aliases: [Mara, the Cartographer]
    status: alive
    introduced: ch-signal-run:12
    birthdate: 2841-03-04
    death_date: null
    facts:
      - key: eye_color
        value: grey
        provenance: ch-signal-run:44
      - key: affiliation
        value: kestrel-syndicate
        provenance: ch-signal-run:51
  - id: the-undervault
    type: place
    name: The Undervault
    aliases: [the sealed levels]
    status: alive
    introduced: ch-signal-run:77
  - id: kestrel-syndicate
    type: faction
    name: Kestrel Syndicate
    aliases: [the Kestrels]
    status: alive
    introduced: ch-signal-run:51
timeline:
  - date: 2859
    event: The Undervault door is sealed
    provenance: ch-signal-run:88
  - date: 2863-06-01
    event: The vault heist begins
    provenance: ch-vault-heist:15
threads:
  - id: the-missing-map
    status: open
    opened: ch-vault-heist
    closed: null
  - id: the-vault-door
    status: closed
    opened: ch-signal-run
    closed: ch-vault-heist
```

## Revisions

- 2026-07-23: canon block seeded from ch-signal-run and ch-vault-heist.
