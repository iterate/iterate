# Screen font

`press-start-2p-ascii.woff2` is Press Start 2P by CodeMan38, downloaded from the
official Google Fonts CSS API on 2026-09-21 with the `text` subset U+0020–U+007E
(printable ASCII). It is 2,492 bytes. The downloaded font is unchanged.
Its SIL Open Font License is in `press-start-2p-OFL.txt`.

- [Google Fonts family](https://fonts.google.com/specimen/Press+Start+2P)
- [Upstream font and license](https://github.com/google/fonts/tree/main/ofl/pressstart2p)

`apps/agents/scripts/build-voice-install.ts` embeds this font in `pixel-font.css` and stores that CSS in
a content-addressed `voice/…/screen-font.css` project KV entry. A rendering script inserts
the CSS into its HTML; Chromium needs no external font request. The model never
needs to generate or read the font's base64 bytes. The CSS family name is
`Iterate Pixel`; use normal weight at 16px or 24px with integer positions.
