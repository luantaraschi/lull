# Visual identity

## README wordmark

The README hero is the project name, not a product diagram. It preserves the
existing `lull` identity while adopting the same name-only restraint used by
`eventlaw`: a centered lowercase wordmark on a transparent 1280 × 280 canvas,
with generous negative space and no secondary copy.

The wordmark keeps the site's IBM Plex Mono face, medium weight, wide tracking,
and paper/ink palette. It does not borrow `eventlaw`'s heavy sans serif or
violet-to-teal gradient.

## Assets

- `assets/lull-wordmark-light.png` is the light-theme fallback;
- `assets/lull-wordmark-dark.png` is selected by GitHub in dark mode;
- both PNGs preserve alpha at 1280 × 280;
- `scripts/banner.html` is the editable source for both themes;
- `node scripts/shoot-banner.js` regenerates the PNGs through a local Chrome
  DevTools endpoint;
- `assets` is included in the npm package so its README keeps working there.

The light wordmark uses `#14181b`; the dark wordmark uses `#f1f3f2`. The renderer
loads IBM Plex Mono from the same Google Fonts source already used by the old
README banner.

The image alt text is simply `lull`. Product explanation stays in normal README
text, where it remains searchable and accessible.

## Handoff — 2026-08-19

The name-only direction is implemented and visually reviewed in both themes.
The old explanatory panel assets were removed. The committed PNGs are the
runtime artifact; regeneration still depends on the Google Fonts source used by
`scripts/banner.html`.

Verification passed with 46 tests, typecheck, build, formatting, `publint`,
`attw`, and an npm dry run that includes both PNGs. No reducer, runtime, default,
or public API behavior changed.
