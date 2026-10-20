# Brand mark

The Tsrust IPTV mark is an amber tuning dial on an ink-navy tile: a screen frame, a dial scale and a lit needle. It joins the two marks the app used to have (the favicon's TV outline and the rail's needle over a baseline) and replaces the blue play triangle the app and PWA icons used to show. It follows the "Night Tuner" design language in `src/styles/tokens.css`: navy surfaces and one amber accent.

The masters live here, not under `crates/iptv-tauri/icons` or `public/`, because they feed both the desktop and the web icons, and nothing in `docs/` ships in either build.

## Files

| File | What it is | Rendered to |
| --- | --- | --- |
| `mark.svg` | The mark on its rounded tile, transparent corners. 1024 px canvas, 64-unit grid. | Every file in `crates/iptv-tauri/icons` (through `tauri icon`), `public/icons/icon-192.png`, `icon-512.png`, `favicon-32.png`, and copied as `public/icons/favicon.svg` |
| `mark-maskable.svg` | Full-bleed and opaque, glyph scaled to 86 % so it stays inside the 80 % safe circle of launcher masks. | `public/icons/icon-maskable-512.png`, `apple-touch-icon.png` (180 px; iOS rounds the corners itself) |
| `mark-mono.svg` | The glyph alone in `currentColor`, cropped square around it. | Not rendered; `BrandMark variant="mono"` draws it |
| `shortcut-*.svg` | The tile with a Lucide glyph (ISC licence) for the manifest shortcuts. | `public/icons/shortcut-*.png` (96 px) |

Two inline copies of `mark.svg` exist so they paint without a request: the boot splash in `index.html` (ids prefixed `boot-`) and `src/ui/BrandMark.tsx`. Update both by hand when the master changes; `src/ui/test/brand.test.tsx` fails when either drifts from `mark.svg`.

## Construction

- The tile is 64 units with a 14-unit corner radius. Its gradient runs `#1d283b` to `#111827` to `#0a0e17`, around the app background `#0c1320`. A 1-unit white rim fades out from the top edge, and a faint amber glow sits behind the needle.
- The frame is a 4-unit stroke whose outer edge sits on the 4-unit grid (x 12 to 52, y 16 to 44). At 16 px, 4 units make one pixel, so the frame stays sharp at 16 and 32 px without a separate small drawing.
- The frame runs from `#ffc964` at the top to `#e3972a` at the bottom. The needle runs from `#fff4da` to `#f5b544` (the amber accent token) and is the brightest thing in the mark.
- The needle stands at x 34, a little right of centre, over a scale tick.

## Use

- The colour mark looks the same in every theme and with every accent. Don't tint it with the user's accent colour.
- Use `variant="mono"` on coloured or busy surfaces, and wherever the mark should take the text colour.
- The smallest size is 16 px. Below 24 px the scale ticks blur into a line, and that is fine.

## Regenerating the icons

After editing a master, run:

```
node tools/brand-icons.mjs
```

It renders each PNG straight from the vector with Playwright's Chromium (`pnpm exec playwright install chromium`, or `PW_CHANNEL=msedge` to use Edge). It then runs `tauri icon` on a 1024 px render and copies the top-level files of its output into `crates/iptv-tauri/icons`. That set covers `icon.ico` (16 to 256 px), `icon.icns`, the PNG sizes and the Windows Store logos. The Android and iOS folders `tauri icon` also writes are dropped; the bundle targets Windows only. Commit the masters and every regenerated file together.
