# Decision: picture mode for multiple monitors, and the text margin at the dock

Date: 2026-10-23. Plan Task 9. Spec section 5.6, "Risk: mixed scales", and
section 6.1.

## Decision

1. **`picture-options` stays `spanned` for all monitor layouts, also for
   monitors with different scales.** The updater does not use the `zoom`
   fallback of spec 5.6. The README does not need a limit for mixed-scale
   setups.
2. **The text starts 96 px from the left edge of each monitor** (it was
   64 px). The other three edges stay at 64 px. `core/render.js`:
   `MARGIN = 64`, `MARGIN_LEFT = 96` (logical pixels, at scale 1).

Reasons:

- All five layouts of spec 5.6 passed on GNOME 50 (Fedora 44) and GNOME 46
  (Ubuntu 24.04). Layout 5 (scales 1 and 2) passed in both layout modes of
  Mutter (see "Results").
- The spec says that Mutter "does not multiply the monitor offset". That is
  not correct for `spanned`. Mutter multiplies the whole monitor rectangle,
  the offset included, by the monitor scale before it computes the picture
  area (see "Why mixed scales pass").
- The Ubuntu Dock covers the left 66 px of the primary monitor (icon size
  48, the default). At icon size 64, the largest size in Ubuntu Settings, it
  covers 82 px. With a 64 px margin, the title and the legend touched the
  dock. At 96 px, the text is 14 px from the dock at the largest icon size
  (see "Dock and top bar").

## Results

Command: `tests/gnome/run.sh fedora44 layouts && tests/gnome/run.sh ubuntu2404 layouts`.
Fedora 44: GNOME Shell 50.6, GJS 1.88.1. Ubuntu 24.04: GNOME Shell 46.0,
GJS 1.80.2.

For each layout, the scenario starts GNOME Shell with the virtual monitors
of the layout and sets the scales with `ApplyMonitorsConfig` (method 1,
temporary). Then it runs `updater/main.js` once against a local fixture
server, takes a screenshot, and runs `tests/gnome/compare.js`. `compare.js`
checks 25 points on each monitor (see "Test"). "25/25" means that all 25
points of the monitor show the correct pixel of the picture.

| Layout | Virtual monitors | Scales | Fedora 44: Mutter mode, picture | Fedora 44 | Ubuntu 24.04: Mutter mode, picture | Ubuntu 24.04 |
|---|---|---|---|---|---|---|
| 1 | 1920×1080 | 1 | logical, 1920×1080 | 25/25 | physical, 1920×1080 | 25/25 |
| 2 | 3840×2160 | 2 | logical, 3840×2160 | 25/25 | physical, 3840×2160 | 25/25 |
| 3 | 1080×1920 | 1 | logical, 1080×1920 | 25/25 | physical, 1080×1920 | 25/25 |
| 4 | 1920×1080, 2560×1080 | 1, 1 | logical, 4480×1080 | 25/25, 25/25 | physical, 4480×1080 | 25/25, 25/25 |
| 5 | 1920×1080, 3840×2160 | 1, 2 | logical, 7680×2160 | 25/25, 25/25 | physical, 5760×2160 | 25/25, 25/25 |
| 5l | 1920×1080, 3840×2160 | 1, 2 | logical, 7680×2160 | 25/25, 25/25 | logical, 7680×2160 | 25/25, 25/25 |
| 5z | layout 5 with `zoom` | 1, 2 | 3840×2160 | 25/25, 25/25 | 3840×2160 | 25/25, 25/25 |

- **Mutter mode.** GNOME 50 uses the logical layout mode: monitor positions
  and sizes are in logical pixels. GNOME 46 uses the physical layout mode,
  and the logical mode only when the experimental feature
  `scale-monitor-framebuffer` is on (Ubuntu Settings turns it on with
  "Fractional Scaling"). Layout 5l is layout 5 with that feature on. In the
  logical mode, the picture has the size of the logical layout times the
  highest scale (`pictureLayout` in `core/layout.js`), so the scale-2 monitor
  gets 2 picture pixels for each logical pixel.
- **5z** is the `zoom` fallback of spec 5.6: `AIR_RAID_MAP_PICTURE_OPTIONS=zoom`
  and `AIR_RAID_MAP_DISPLAY=3840x2160@2` (one map with the size of the primary
  monitor at the highest scale). It also passed. It is not needed, but the
  scenario keeps it, so the fallback stays tested.

I looked at every screenshot of both images (`tests/gnome/out/<image>-layouts/layout-<n>.png`).
In each one: one whole map on each monitor, in the center of the monitor,
not cut and not stretched (the synthetic map is a square, and it stays
square). All text is inside the margins. No text is under the top bar or
the dock. In layout 5, the map on the scale-2 monitor is sharp, and the
monitors show the same map at the same logical size.

A second run with the real NEPTUN boundaries
(`GNOME_TEST_BOUNDARIES=<folder>`; the files are not in the repository)
gave the same counts on both images. Its screenshots show the oblast names,
the threat icons and all text in the correct places.

## Why mixed scales pass

`meta-background.c` (Mutter 46.0 and the main branch) draws the background
of each monitor:

- `meta_background_get_texture` multiplies the monitor rectangle by the
  monitor scale: `monitor_area.x`, `y`, `width` and `height`, for every
  style except `wallpaper`.
- `get_texture_area`, style `spanned`: the picture area is the screen size
  times the monitor scale, at `-monitor_rect->x`, `-monitor_rect->y`. This
  is the rectangle that was multiplied above.

The size and the offset both get the monitor scale, so each monitor shows
its own rectangle of the picture. The picture must only have the aspect
ratio of the bounding box of all monitors, and each monitor rectangle must
be at the same relative position in it. `pictureLayout` does this.

## Dock and top bar

Measured in the screenshots of the Ubuntu image (columns where the screen
differs from the picture, on 149 rows):

| Dock icon size | Dock covers | Clearance of the text at 64 px | Clearance at 96 px |
|---|---|---|---|
| 48 (default) | x < 66 | none: the ink of the title and legend starts at x = 66 | 30 px |
| 64 (largest in Ubuntu Settings) | x < 82 | text under the dock | 14 px |

The dock is only on the primary monitor. The text area moves on every
monitor, so all maps stay the same. The map is centered on the monitor, so
it does not move. The loading message ("Завантаження мапи…") also stays
centered on the monitor.

The top bar is 32 px high on GNOME 46 and 50 (logical pixels). The text
starts at y = 64, so the top margin stays 64 px. The top bar and the dock
are both on the primary monitor only.

## Test

- `tests/gnome/scenarios/layouts.sh`: the scenario. `GNOME_TEST_LAYOUTS`
  selects layouts (default `1 2 3 4 5 5l`). `GNOME_TEST_BOUNDARIES` draws
  other boundary files instead of the synthetic square.
- `tests/gnome/scenarios/monitors.js`: sets the scales with
  `ApplyMonitorsConfig` (method 1), with the serial and the current mode IDs
  from `GetCurrentState`. The monitors are side by side from x = 0, and the
  first `--virtual-monitor` is primary. The scenario then waits until
  `Main.layoutManager.monitors` shows the new layout.
- `tests/gnome/scenarios/fixture.js`: writes the files of the fixture server:
  the synthetic square of `tests/lib/fixtures.js` with a red alert, and the
  synthetic threats. The picture is the same on each run.
- `tests/gnome/compare.js`: for each monitor, a 5 × 5 grid inside the
  monitor. The grid skips the top 48 and the left 80 logical pixels (the top
  bar and the dock). It maps each point from picture pixels to screenshot
  pixels by the ratio of the two sizes. A point matches when each channel of
  the screenshot pixel is at most 12 outside the range of the picture pixels
  that GNOME can mix into it (the screen pixel and one picture pixel on each
  side). In a flat area this is "differs by 12 or less". It also fails when
  the screenshot has another aspect ratio than the picture. With `--zoom` it
  maps each monitor to the whole picture, scaled to cover the monitor and
  centered, as Mutter does for `zoom`.
- Checks of `compare.js` on a Task 8 screenshot: the same picture gives
  25/25. The screenshot moved 300 px to the right gives 13/25. The screenshot
  stretched to 1920×1200 fails the aspect ratio check.

## Limits of the test

- No fractional scales (1.25, 1.5). Mutter rounds the scaled monitor
  rectangle to whole pixels, so a fractional scale can move the picture by
  one pixel.
- Monitors only side by side and top-aligned. A monitor above another, or
  with a different top edge, uses the same Mutter code.
- In portrait (1080 px wide), the map starts at x = 59 (the map padding of
  `mapTransform`, 5.5 % of the width). On Ubuntu, the dock (x < 66) covers
  the west tip of Zakarpattia by 7 px. The dock is translucent, and the oblast
  name is not under it. This task did not change the map padding.
