# Third-party notices

## Font Awesome Free 7.3.1

Icons: CC BY 4.0. Package code: MIT. Attribution is preserved in
`apps/web/public/fontawesome-notice.txt`.
See https://fontawesome.com/license/free and https://creativecommons.org/licenses/by/4.0/.

## Hanzi Writer 3.7.3

The web canvas uses Hanzi Writer's public scaling transform. The server-side
stroke engine contains an adapted TypeScript implementation of Hanzi Writer's
stroke-matching algorithm so that the authoritative result does not depend on
client-side callbacks.

- Project: https://github.com/chanind/hanzi-writer
- License: MIT
- Full license text: `licenses/HANZI_WRITER_LICENSE`

### Modification notice

On 2026-06-28, the matcher was adapted to accept normalized `[0,1]` points,
return detailed checks compatible with the game's result codes, and compare
the attempted stroke with later strokes before the server advances the turn.

## Hanzi Writer Data 2.0.1

The curated stroke outline and median data for the 20-character validation set
`木 水 人 十 一 二 三 四 五 六 七 八 九 日 月 山 火 口 大 小` is loaded from
`hanzi-writer-data`.

- Project: https://github.com/chanind/hanzi-writer-data
- Upstream data: Make Me A Hanzi
- License: Arphic Public License
- Full license text: `licenses/ARPHICPL.TXT`

### Modification notice

On 2026-06-28, this project added a runtime adapter that converts the upstream 1024-unit Cartesian median coordinates into normalized `[0,1]` canvas points, derives checkpoint samples, and attaches local Korean labels and judgment tolerances. The original SVG outline path strings are not modified.

## HANJADICT Korean readings and meanings

The server uses a local Korean reading/meaning mapping to prefill teacher review fields.
Teachers may edit the suggestion before approving a character for their own folders.

- Project: https://github.com/ssut/hanja
- License: MIT
- Full license text: apps/server/src/data/HANJADICT-LICENSE.txt
