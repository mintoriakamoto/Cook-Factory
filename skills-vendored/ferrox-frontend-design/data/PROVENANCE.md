# Provenance

Every file in this directory is ported from `ijfw-design` (Sean Donahoe's own IP; internal
port into Ferrox Factory, ijfw repo untouched). CSV and JSON files cannot carry in-band
comment headers without breaking their parsers, so this note is the credit line for all of
them:

- `palettes.csv` - 60+ role-mapped palettes with WCAG levels and sources
- `patterns.csv` - product-type layout patterns with style priorities and anti-patterns
- `ux-guidelines.csv` - severity-tagged UX rules with do/don't guidance and sources
- `typography.csv` - heading/body stacks with minimum sizes and line heights
- `google-fonts.csv` - font pairings with imports, moods, and license notes
- `styles.csv` - named style directions with best-for and avoid-for fields
- `charts.csv` - chart types with best-for and accessibility grades
- `brand-atlas.json` - 12 domains x 3-5 reference brands with palette and type hints
- `reasoning.csv` - product-keyword rules mapping to style/palette/type/pattern picks

Queried by `../scripts/search.js` (zero-dep, skill-relative paths). Do not add header rows
or comments to the CSV files; the parser treats line 1 as column headers.
