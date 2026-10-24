# GNOME Air Raid Map: design

- Date: 2026-10-23
- Status: complete, approved by the owner on 2026-10-23
- Repository: `p5ych0/gnome-air-raid-map` (public)
- Local folder: `~/Work/gnome-air-raid-map`
- Reference project: `p5ych0/plasma-air-raid-map` 0.2.2, local folder `~/Work/map`

## 1. Intent

This project shows live air-raid alerts across Ukraine as the desktop
wallpaper on GNOME. It is the GNOME version of
[`plasma-air-raid-map`](https://github.com/p5ych0/plasma-air-raid-map),
which works only on KDE Plasma 6.

The idea comes from
[FullyRealist/LivelyAirRaidAlert](https://github.com/FullyRealist/LivelyAirRaidAlert).
That project loads NEPTUN's web map (`https://neptun.in.ua/embed/map`) in a
Chromium-based wallpaper engine on Windows. The Plasma project replaced the
web map with a native drawing from NEPTUN's public data. This project keeps
the native approach.

GNOME has no API for live wallpapers. A program can only set a picture file
as the wallpaper. Therefore the first release is an **updater**: a short
program that draws the map as a PNG picture, sets it as the wallpaper, and
exits. A systemd user timer starts it every 30 seconds.

A live **GNOME Shell extension** is a second, later product in the same
repository. Section 9 describes its place. This document does not plan it.

### 1.1 Why native and not the web map

We measured both on 2026-10-22 and 2026-10-23. The test used 1920×1080,
60-minute runs, and samples every 30 seconds. PSS is the memory that a
process group really uses, with shared pages divided between processes.

| Candidate | PSS after warm-up | CPU | Notes |
|---|---|---|---|
| WebKitGTK 6.0 with the NEPTUN embed (as Hidamari or a Hanabi fork would show it) | 1054–1216 MB, 9 processes | 70–94 % of one core | Redraws 8–34 times per second |
| Chrome with the NEPTUN embed (as Lively shows it) | 730–816 MB, 12 processes | 150–167 % | JS heap after forced GC grew 15.6 → 16.7 MB in 1 hour |
| Plasma QML map (`~/Work/map`) | 73 MB, 1 process | 0.5 % | Flat |
| GJS + Soup + Cairo spike, resident, forced GC after each poll | 43–69 MB, 1 process | 0.4 % | One step to 69 MB, then flat (+0.3 MB/h) |
| GJS spike, one run then exit | 92 MB peak for 0.6 s | 0.25 s CPU per run | Nothing stays in memory between runs |

The NVIDIA driver on the test machine had a version mismatch. Both browsers
used software WebGL. Their CPU numbers are therefore too high for a working
GPU. Their memory numbers are comparable.

The embed also downloads about 2.5 MB at start (with 1.1 MB of satellite
images). After start, it receives about 20 KB per minute on a WebSocket.

## 2. Users and scope

The first release is for people who use GNOME on Linux and want the alert
map as their wallpaper.

**Supported GNOME versions (decision of the designer):** GNOME 46 and newer.
Examples: Ubuntu 24.04 LTS, Ubuntu 26.04 LTS, Debian 13, Fedora 40 and newer.
The updater uses only the stable `org.gnome.desktop.background` settings.
These settings did not change in these versions.

## 3. Goals, non-goals, anti-goals

### 3.1 Goals

1. The picture shows the same content as the Plasma project 0.2.2 (section 6).
2. The picture uses the actual size and aspect ratio of each monitor (section 5.6).
3. The picture follows the same data rules as the Plasma project (section 6.2).
4. Nothing stays in memory between runs.
5. One run uses less than 1 s of CPU time. Its peak memory is less than
   120 MB at 1920×1080, and less than 200 MB at the size cap (section 5.6).
   We measure the CPU time on a quiet machine and record the load. The rule
   and the measured margins are in
   [`docs/decisions/2026-10-24-cpu-budget.md`](../../decisions/2026-10-24-cpu-budget.md).
6. Average CPU use stays below 1 % of one core.
7. The project reuses the JavaScript of the Plasma project where possible.
8. The picture always shows the NEPTUN attribution and the official-alerts notice.
9. Install and uninstall need no root access.
10. Uninstall puts back the wallpaper that the user had before.

### 3.2 Non-goals for the first release

- Desktops other than GNOME (Cinnamon, MATE, Budgie, XFCE, Sway, Plasma 5).
- The live GNOME Shell extension. The README announces it as "in development".
- The lock-screen picture (`org.gnome.desktop.screensaver`).
- Sound, notifications, or any interaction with the map.
- Distribution packages (DEB, RPM, Flatpak, AUR).
- Languages other than Ukrainian on the picture.
- Prediction of threat movement between polls.

### 3.3 Anti-goals

These results are failures, even if the program works:

- The picture shows old data as current data, without a visible time or a
  stale-data mark.
- The picture shows "no alert" when a request failed.
- A marker appears at an invented position, or at the map edge instead of
  off the map.
- The program uses a browser engine, WebGL, or continuous animation.
- The program changes system files or asks for root access.
- The program writes the picture to the disk again and again.
- The user loses the wallpaper that they had before.

## 4. Constraints

### 4.1 NEPTUN API and terms

Sources: <https://neptun.in.ua/developers> and <https://neptun.in.ua/api-terms>.

- The API is free, read-only, and has no keys. Use only GET requests.
- Poll REST endpoints no more often than once every 5 seconds.
- Show a visible link to `https://neptun.in.ua/` next to the map or data.
  On a picture, the link is the printed text `neptun.in.ua`.
- Do not use the NEPTUN name or logo as the identity of this project.
- NEPTUN is an information aggregator, not an official alert system. The
  picture must tell users to follow official air-raid alerts.
- Boundary data belongs to its owners (OpenStreetMap and others). The
  repository must not include the GeoJSON files. A local cache on the user's
  computer is not redistribution.

Endpoints:

| Endpoint | Size (raw / gzip) | Server cache headers |
|---|---|---|
| `/oblasts.geojson` | 160 KB / 50 KB | `ETag`, `Last-Modified`, `max-age=3600` |
| `/raions.geojson` | 630 KB / 180 KB | `ETag`, `Last-Modified`, `max-age=3600` |
| `/api/v1/alerts` | about 9 KB | `ETag`, `max-age=5` |
| `/api/v1/threats` | about 15 KB | `ETag`, `max-age=5` |

The alerts response has `version` and `updatedAt`. The threats response has
`epoch`, `seq`, and `serverTime`. The documentation does not describe these
fields. The program must not depend on them.

### 4.2 Platform

- GNOME has no live-wallpaper API. Every live-wallpaper tool for GNOME is a
  Shell extension that changes Shell internals.
- GNOME Shell watches the wallpaper file. When the file changes, the Shell
  reloads it and fades to the new picture in 1 second (`js/ui/background.js`,
  GNOME 50). The Shell ignores `CHANGED` and `CREATED` file events. It waits
  for `CHANGES_DONE_HINT`. Section 5.6 explains the risk.
- All required libraries come with GNOME: GJS, libsoup 3, Cairo, Pango, and
  the systemd user session. The install script must check for them.

### 4.3 License and credit

- License: MIT, the same as the Plasma project.
- The README credits FullyRealist/LivelyAirRaidAlert for the original idea.
- The README links to `plasma-air-raid-map` for KDE Plasma 6 users.
- The future extension must use a GPL-compatible license to be on
  extensions.gnome.org. MIT is GPL-compatible.

## 5. Decided design

### 5.1 Repository layout

```
core/        Shared code: data rules, projection, drawing, threat symbols
updater/     The GJS program that one timer run starts
systemd/     User service and timer units
tests/       Unit tests, visual fixtures, integration scripts
docs/        Design, plans, screenshots
extension/   Later: the live GNOME Shell extension
```

`core/` must not import GTK, Clutter, St, Meta, or Shell. Then the updater
and the future extension can both use it.

### 5.2 Languages and libraries

- GJS with ES modules (`gjs -m`).
- libsoup 3 for HTTP, with gzip decoding.
- Cairo for shapes, Pango and PangoCairo for text.
- Gio for files, settings, and D-Bus.
- No npm packages, no Python, no compiled code.

### 5.3 Code reuse from the Plasma project

| Plasma file | Use in this project |
|---|---|
| `MapData.js` | Port to an ES module in `core/`. Remove `.pragma library`. Keep the validation rules and the error messages. |
| `ThreatSymbols.js` | Port to `core/`. Keep the silhouettes and the rotation rules. |
| `AlertMap.qml` (`onPaint` and text items) | Port the drawing to Cairo. Keep the colors, sizes, and layout rules. |
| `AlertSource.qml` | Port the stale rules. Replace `XMLHttpRequest` with Soup and `Timer` with the systemd timer. |
| `tests/tst_*.qml` | Port the test cases to GJS tests. |

### 5.4 One run of the updater

1. Read the state file (section 5.5).
2. Load the boundary data from the cache. If the cache is empty or older than
   one hour, send a conditional request (`If-None-Match`). Download again only
   if the server copy changed.
3. Request `/api/v1/alerts` and `/api/v1/threats` at the same time. Each
   request has a 15-second timeout. The requests trust the system CA file
   `/etc/ssl/certs/ca-certificates.crt`, or the default trust store if the
   updater cannot load that file
   ([`docs/decisions/2026-10-24-cpu-budget.md`](../../decisions/2026-10-24-cpu-budget.md)).
4. Validate each response with the rules from `MapData.js`. A response that
   does not pass validation counts as a failed request.
5. Store each valid response and its time in the state file.
6. Calculate the stale state for alerts and for threats (section 6.2).
7. Build the render key: a hash of all data and all text that the picture
   shows, and of the monitor layout.
8. If the render key is the same as the last key and the picture file
   exists, go to step 10.
9. Draw the picture. Write it to the picture path (section 5.6). Write the
   new render key to the state file.
10. If the wallpaper settings do not point to the picture, set them. This
    also puts the live picture back after the failure banner (section 5.7).
11. Exit.

### 5.5 Files

| File | Location | Lifetime |
|---|---|---|
| Boundary cache | `$XDG_CACHE_HOME/gnome-air-raid-map/` (normally `~/.cache/…`) | Survives reboot |
| State file (last valid data, times, ETags, render key) | `$XDG_RUNTIME_DIR/gnome-air-raid-map/` (RAM) | Deleted at logout |
| Picture | `$XDG_RUNTIME_DIR/gnome-air-raid-map/` (RAM) | Deleted at logout |
| Previous wallpaper settings | `$XDG_STATE_HOME/gnome-air-raid-map/` (normally `~/.local/state/…`) | Until uninstall |
| Failure banner (section 5.7) | `$XDG_DATA_HOME/gnome-air-raid-map/` (normally `~/.local/share/…`) | Until uninstall |

The picture is in RAM for two reasons:

- Repeated writes do not wear the disk.
- After logout or reboot, the old picture does not exist. GNOME cannot show
  old data as current data at the next login.

### 5.6 Picture and wallpaper settings

**Requirement (from the owner): the picture uses the actual screen size and
aspect ratio.** The map layout comes from the real size of each monitor. It
never comes from a fixed size, and GNOME must not crop or stretch the map.
This rule is for the map picture. The failure banner (section 5.7) has one
exception on narrow monitors. Section 5.7 describes it.

- **Monitor layout:** each run reads the current monitor layout from the
  `org.gnome.Mutter.DisplayConfig` D-Bus interface (`GetCurrentState`). For
  each monitor, the layout gives the position, the size, the scale, and the
  rotation. A rotated monitor swaps its width and height.
- **One picture for all monitors:** `picture-options` is `spanned`. GNOME
  maps one picture over the bounding box of all monitors. Each monitor shows
  its own rectangle of the picture (`meta-background.c`, GNOME 46 and 50).
- **One map for each monitor (decision of the designer):** the updater draws
  a full map, with all text, inside the rectangle of each monitor. This
  copies the Plasma project, where each screen has its own wallpaper. The map
  layout uses the width and height of that rectangle, as `AlertMap.qml` does.
- **Resolution:** the picture has enough pixels for the monitor with the
  highest scale. Example: at 200 % scale, a 12-pixel icon becomes 24 physical
  pixels. Text and lines are sharp on each monitor.
- **Size cap (decision of the designer):** the picture has 16.6 megapixels or
  fewer (the area of two 4K monitors). If the layout needs more, the updater
  scales the whole picture down by one factor. The aspect ratio does not
  change, and GNOME scales the picture up again. Only very large setups (5K,
  8K, three or more 4K monitors) lose some sharpness. The cap keeps a run
  inside the memory limits of section 5.7.
- **Single monitor:** the picture is exactly the monitor size in physical
  pixels. GNOME shows it 1:1, without scaling.
- **Layout changes:** the monitor layout is part of the render key (section
  5.4). After a change of resolution, rotation, scale, or monitors, the next
  run draws a new picture. The delay is 30 seconds or less.
- **No layout:** if the D-Bus call fails, the updater uses the last layout
  from the state file. If no layout was ever read, the run fails and does not
  guess a size.
- **Settings:** `picture-uri` and `picture-uri-dark` point to the picture.
- **Time labels (decision of the owner: A, with B as the fallback):**
  - **A (default):** the corner shows "Тривоги: оновлено HH:MM" and
    "Загрози: оновлено HH:MM · N повідомл." (updated at). HH:MM is the
    time of the last valid response of each feed. The picture changes once
    per minute when the data does not change, and at most once per 30
    seconds when the data changes. The changing time shows the user that
    the map is live.
  - **B (fallback):** the corner shows "Тривоги: без змін з HH:MM" and
    "Загрози: без змін з HH:MM · N повідомл." (no changes since). HH:MM is
    the time of the last change in the data of each feed. The picture
    changes only when the data or the stale state changes.
  - **Gate:** check 5 of section 7.4 decides. If A fails that check, the
    builder switches to B and reports the measurements to the owner.
  - The stale rules of section 6.2 are the same in A and B.

**Risk: mixed scales.** In `spanned` mode, Mutter multiplies the image size
by the monitor scale. If it did not also multiply the monitor offset, a
monitor could show the wrong part of the picture when two monitors have
different scales. The builder must test these layouts in GNOME Shell:

1. One monitor, 1920×1080, scale 1.
2. One monitor, 3840×2160, scale 2.
3. One monitor rotated to portrait.
4. Two monitors with different aspect ratios, both at scale 1.
5. Two monitors at different scales (1 and 2).

Pass criteria: each monitor shows one whole map, centered, not cut, not
stretched. All text is inside the margins of section 6.1. If layout 5 fails,
the builder uses the fallback: `picture-options` is `zoom`, and the picture
has the size and aspect ratio of the primary monitor. The README then states
the limit for mixed-scale setups.

**Result (Task 9): the fallback was not needed.** All five layouts passed on
GNOME 50 (Fedora 44) and GNOME 46 (Ubuntu 24.04). Layout 5 passed in both
layout modes of Mutter (logical and physical). Mutter multiplies the whole
monitor rectangle by the monitor scale, the offset included, before it
computes the picture area (`meta-background.c`). An earlier version of this
section said that Mutter does not multiply the offset. That was wrong.
`picture-options` stays `spanned` for all layouts, and the README states no
limit for mixed-scale setups. See
[`docs/decisions/2026-10-23-multi-monitor-mode.md`](../../decisions/2026-10-23-multi-monitor-mode.md).

**Risk: picture reload.** GNOME reloads the picture after a
`CHANGES_DONE_HINT` file event. An atomic rename (write to a temporary file,
then rename) probably does not send that event. The builder must test these
methods in a real GNOME Shell and use the first one that passes:

1. Write the same path in place.
2. Write a temporary file and rename it over the picture.
3. Use two file names in turn (A, B). Set `picture-uri` to the new name.
   Delete the old file after GNOME shows the new one.

Pass criteria: GNOME shows each new picture within 2 seconds. No black or
empty frame appears between pictures. 100 updates in a row all pass.

Method 3 changes the settings on each update. dconf then writes its
database file to the disk each time. If method 3 is the only method that
passes, the builder measures the bytes that dconf writes per day and
reports the number to the owner before the release.

**Result (Task 7): `rename`.** Methods 1 and 2 both passed 100 of 100
updates on both images. Method 3 failed. The guess above was wrong: GLib
sends `CHANGES_DONE_HINT` for a file that a rename replaces. The updater uses
method 2, not method 1. The reason: when a run stops during a write, method 1
shows an incomplete picture, and that breaks the rule "no black or empty
frame". dconf wrote nothing during the updates of methods 1 and 2. When the
settings do not point to the live picture (for example, after the failure
banner), the updater writes the picture under a new file name. The reason:
the Shell can keep an old copy of a file name that it showed before. See
[`docs/decisions/2026-10-23-picture-reload-method.md`](../../decisions/2026-10-23-picture-reload-method.md).

### 5.7 Scheduling

- A systemd user service runs one updater run (`Type=oneshot`).
- A systemd user timer starts the service 30 seconds after the last run
  (`OnUnitActiveSec=30s`) and at session start.
- The timer starts with `graphical-session.target` and stops with it.
- The service has `MemoryMax=300M` and `TimeoutStartSec=25s`. A broken run
  cannot grow without limit or block the next run.
- After suspend, the timer starts the next run within 30 seconds of resume.

**Failure banner (decision of the designer).** The service has `OnFailure=`
set to a second unit. That unit only runs `gsettings`. It does not start
GJS, Cairo, or Pango, so it cannot fail for the same reason as the updater.
It sets these keys. It changes a key only when the key has another value:

- `picture-uri` and `picture-uri-dark`: the failure banner.
- `picture-options`: `centered`. GNOME shows the banner at its own size
  (1200×360), in the center of each monitor. GNOME never stretches it, so
  the monitor size and aspect ratio do not matter. Exception: on a monitor
  less than 1200 pixels wide, GNOME cuts the banner at its left and right
  sides. On a portrait monitor 1080 pixels wide, GNOME cuts 60 pixels of
  plain background on each side. The text stays fully visible.
- `primary-color`: `#0e1722`, the map background color. The area around the
  banner has the same color.

The install script draws the banner once, as a small PNG in
`$XDG_DATA_HOME`. The banner text is "НЕ ОНОВЛЮЄТЬСЯ" (not updating), "Дані
на шпалерах можуть бути застарілими" (the wallpaper data can be out of
date), and "Дотримуйтеся офіційних сигналів тривоги." It shows no time.
The next successful run sets the live picture and `spanned` again
(section 5.4, step 10).

### 5.8 Install and uninstall

Install (one command, for example `./install.sh`):

1. Check that GJS, libsoup 3, Cairo, Pango, and a systemd user session are
   present. If one is missing, print the package name for the distribution
   and stop.
2. Copy the program to `~/.local/share/gnome-air-raid-map/`, and draw the
   failure banner there (section 5.7).
3. Copy the units to `~/.config/systemd/user/`.
4. Save the current values of `picture-uri`, `picture-uri-dark`,
   `picture-options`, and `primary-color`.
5. Enable and start the timer. Without a graphical session, only enable it.
   The timer then starts at the next graphical login.

Uninstall (`./install.sh --uninstall`):

1. Stop and disable the timer.
2. Put back the saved wallpaper values.
3. Delete the program, the units, the cache, the state, and the pictures.

## 6. Picture content

### 6.1 Layout

The picture copies the Plasma project's layout. See
`~/Work/map/docs/images/kde-plasma-air-raid-map.png`.

- Background `#0e1722`. Oblasts `#223448`. Red level `#cf4655`. Yellow level `#c69235`.
- District borders 0.5 px `#456078`. Oblast borders 1.2 px `#9ab1c6`.
- Oblast labels in Ukrainian, white with a dark outline. No labels for Kyiv
  city and Sevastopol.
- Top left: the title "ПОВІТРЯНІ ТРИВОГИ".
- Top right: the time of the last valid alert data and of the last valid
  threat data, and the number of threat reports.
- Left, below the title: the list of region-only reports, with an overflow count.
- Bottom left: the legend.
- Bottom right: "Дані: neptun.in.ua" and "Дотримуйтеся офіційних сигналів тривоги."
- Threat icons: 12–16 px at scale 1, transparent background, white. Advisory
  icons are blue (`#9ad6f7`). Groups show "×2", "×3", and so on.
- All text stays at least 64 px (at scale 1) from each screen edge.

The GNOME top bar and the Ubuntu Dock must not cover text. The builder
measures this in GNOME and Ubuntu test sessions. If the dock covers text,
the builder increases the left margin.

### 6.2 Data rules

These rules come from the Plasma project 0.2.2. Keep them all.

- A full valid response replaces the previous data. An invalid response does
  not change the data.
- An alert key that is not in the boundary data makes the response invalid.
- Red is drawn after yellow, so yellow cannot hide red.
- Data is stale after a failed request, or 90 seconds after the last valid
  response.
- Stale alert data: alert colors at 40 % opacity, the warning "ДАНІ ЗАСТАРІЛИ"
  in the corner, and the center message "Немає актуальних даних тривог".
- Stale threat data: no threat icons and no region-only list. The corner text
  says "Загрози: немає актуальних даних".
- A threat failure does not stop alert updates. An alert failure does not stop
  threat updates.
- Only `status: "active"` threats appear.
- Region-only threats (`areaOnly: true`) appear only in the list, never on the map.
- A heading rotates an icon only if `presumptiveCourse` is not `true`.
- A threat outside the map area does not appear. It is not moved to the edge.
- An unknown threat type uses the "unknown" symbol.
- Text from the provider is plain text. It is never Pango markup.

## 7. Tests and leak checks

### 7.1 Unit tests

- Port all cases from `tst_alertdata.qml`, `tst_threatdata.qml`, and
  `tst_threatsource.qml`.
- Add tests for the stale rules across runs (state file), the render key,
  and the conditional requests.
- Tests run with `gjs` only. No test framework from npm.

### 7.2 Visual fixtures

- Synthetic data draws every threat symbol, advisory reports, region-only
  reports, a threat-feed failure, and stale alerts.
- Draw each fixture at 1920×1080, at 3840×2160 with scale 2, at 2560×1080
  (21:9), and at 1080×1920 (portrait).
- The fixtures are not part of the installed program.

### 7.3 GNOME integration test

The development machine runs KDE Plasma. Therefore GNOME tests run in a
disposable Podman container with a headless GNOME Shell. Nothing changes on
the host system.

- Images: Fedora 44 (GNOME 50) and Ubuntu 24.04 (GNOME 46).
- Steps: install, wait for 3 runs, take a screenshot, check the picture
  reload (section 5.6), uninstall, check that the old wallpaper is back.
- Run the monitor layouts of section 5.6 with headless virtual monitors.

### 7.4 Resource and leak checks

"No memory leaks" means:

- No process stays in memory between runs.
- The peak memory of a run does not grow over many runs.
- Files and folders do not grow over many runs.
- The memory of `gnome-shell` does not grow because of our picture updates.

Checks:

1. Run the updater 1,000 times against a local fixture server. Do not use
   NEPTUN for this test. Record the peak RSS of each run. Do this once at
   1920×1080 and once at the size cap. Pass: every run is below the limit of
   goal 5, and the trend is flat. Run the check on a quiet machine and
   record the load. The results are in
   [`docs/decisions/2026-10-24-cpu-budget.md`](../../decisions/2026-10-24-cpu-budget.md).
2. After the 1,000 runs, count the files and bytes in the cache and runtime
   folders. Pass: the counts are the same as after run 10.
3. After the 1,000 runs, look for updater processes. Pass: none.
4. Run the real timer against NEPTUN for 24 hours. Record `MemoryPeak` of
   each run from systemd, and count errors in the journal. Pass: memory is
   flat, and every error has a known cause (for example, the network was down).
5. During the 24-hour run, record the PSS and CPU time of `gnome-shell` every
   minute. Compare with a 24-hour run of the same GNOME session without the
   updater. Pass: `gnome-shell` PSS has no upward trend that the control run
   does not have, and the updater adds less than 1 % of one core to
   `gnome-shell` CPU on average.

## 8. Development process

We use these skills in this order:

1. `superpowers:brainstorming`: this design.
2. `superpowers:writing-plans`: the implementation plan.
3. `superpowers:using-git-worktrees`: a separate worktree for each branch.
4. `superpowers:subagent-driven-development` with
   `superpowers:test-driven-development`: the build, task by task.
5. `superpowers:verification-before-completion`: before each claim that work is done.
6. `superpowers:requesting-code-review`: before each pull request.
7. `watch-pr-skill:watch-prs`: each pull request on GitHub goes through the
   Codex and Copilot review loop until it is clean and merged.
8. `superpowers:finishing-a-development-branch`: after each merge.
9. `writing-simplified-technical-english`: for the README, pull request
   descriptions, and other text that people act on.

Other rules:

- Commit messages use the style of the Plasma project (`feat:`, `fix:`, `docs:`).
- The GitHub repository is created after the design is approved. Its
  visibility is confirmed with the owner before creation.
- The `watch-prs` loop needs the Codex GitHub connector for the account and
  Copilot code review for the repository.

## 9. Later: the live GNOME Shell extension

The extension is a second product in the same repository. It is out of scope
for the first release. These points are fixed now so that the first release
does not block it:

- It uses `core/` without changes.
- It draws the map live on the desktop background, inside `gnome-shell`.
- It must follow the extensions.gnome.org review rules. `disable()` must
  remove every object, signal connection, and timer that `enable()` created.
- A leak in the extension slows the whole desktop. It needs its own long
  test in a real GNOME session before release.
- It needs a check against each new GNOME release (every 6 months).
- The README announces it as "in development" until it is ready.

## 10. Left to the builder

- The module boundaries inside `core/`.
- A Canvas-style adapter over Cairo, or a direct port of the drawing calls.
  An adapter keeps `ThreatSymbols.js` almost the same as the Plasma version.
- The cache format for the boundary data (raw GeoJSON or projected points).
- The picture reload method, with the pass criteria from section 5.6.
- The left margin for the Ubuntu Dock, with the rule from section 6.1.
- The format of the state file.
- The test runner script.
- The local fixture server for the leak checks.
