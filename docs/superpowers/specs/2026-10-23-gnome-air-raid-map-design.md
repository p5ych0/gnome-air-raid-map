# GNOME Air Raid Map: design

- Date: 2026-10-23
- Status: draft, waiting for approval
- Repository: `p5ych0/gnome-air-raid-map` (not created on GitHub yet)
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
2. The picture follows the same data rules as the Plasma project (section 6.2).
3. Nothing stays in memory between runs.
4. One run uses less than 120 MB peak memory and less than 1 s of CPU time.
5. Average CPU use stays below 1 % of one core.
6. The project reuses the JavaScript of the Plasma project where possible.
7. The picture always shows the NEPTUN attribution and the official-alerts notice.
8. Install and uninstall need no root access.
9. Uninstall puts back the wallpaper that the user had before.

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
   request has a 15-second timeout.
4. Validate each response with the rules from `MapData.js`. A response that
   does not pass validation counts as a failed request.
5. Store each valid response and its time in the state file.
6. Calculate the stale state for alerts and for threats (section 6.2).
7. Build the render key: a hash of all data and all text that the picture shows.
8. If the render key is the same as the last key, exit.
9. Draw the picture. Write it to the picture path (section 5.6).
10. If the wallpaper settings do not point to the picture, set them.
11. Write the new render key to the state file. Exit.

### 5.5 Files

| File | Location | Lifetime |
|---|---|---|
| Boundary cache | `$XDG_CACHE_HOME/gnome-air-raid-map/` (normally `~/.cache/…`) | Survives reboot |
| State file (last valid data, times, ETags, render key) | `$XDG_RUNTIME_DIR/gnome-air-raid-map/` (RAM) | Deleted at logout |
| Picture | `$XDG_RUNTIME_DIR/gnome-air-raid-map/` (RAM) | Deleted at logout |
| Previous wallpaper settings | `$XDG_STATE_HOME/gnome-air-raid-map/` (normally `~/.local/state/…`) | Until uninstall |

The picture is in RAM for two reasons:

- Repeated writes do not wear the disk.
- After logout or reboot, the old picture does not exist. GNOME cannot show
  old data as current data at the next login.

### 5.6 Picture and wallpaper settings

- **Size:** the resolution of the primary monitor, in physical pixels. The
  updater reads it from the `org.gnome.Mutter.DisplayConfig` D-Bus interface
  (`GetCurrentState`). If that call fails, the size is 1920×1080.
- **Scale:** the updater draws all text and symbols at the monitor scale.
  Example: at 200 % scale, a 12-pixel icon becomes 24 physical pixels.
- **Settings:** `picture-uri` and `picture-uri-dark` point to the picture.
  `picture-options` is `zoom`.
- **Other monitors:** they show the same picture with `zoom`. If their aspect
  ratio is different, GNOME crops the edges. This is accepted for the first
  release.
- **Time labels:** minute precision (`HH:MM`). Then the picture changes at
  most once per minute when the data does not change.

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

### 5.7 Scheduling

- A systemd user service runs one updater run (`Type=oneshot`).
- A systemd user timer starts the service 30 seconds after the last run
  (`OnUnitActiveSec=30s`) and at session start.
- The timer starts with `graphical-session.target` and stops with it.
- The service has `MemoryMax=200M` and `TimeoutStartSec=25s`. A broken run
  cannot grow without limit or block the next run.
- After suspend, the timer starts the next run within 30 seconds of resume.

**Failure picture.** The service has `OnFailure=` set to a second unit. That
unit sets the wallpaper to a fixed picture with the text "НЕ ОНОВЛЮЄТЬСЯ"
(not updating) and the time. The install script draws this picture once.
The next successful run sets the live picture again.

### 5.8 Install and uninstall

Install (one command, for example `./install.sh`):

1. Check that GJS, libsoup 3, Cairo, Pango, and a systemd user session are
   present. If one is missing, print the package name for the distribution
   and stop.
2. Copy the program to `~/.local/share/gnome-air-raid-map/`.
3. Copy the units to `~/.config/systemd/user/`.
4. Save the current values of `picture-uri`, `picture-uri-dark`, and
   `picture-options`.
5. Draw the failure picture.
6. Enable and start the timer.

Uninstall (`./install.sh --uninstall` or `./uninstall.sh`):

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
- Draw each fixture at 1920×1080 and at 3840×2160 with scale 2.
- The fixtures are not part of the installed program.

### 7.3 GNOME integration test

The development machine runs KDE Plasma. Therefore GNOME tests run in a
disposable Podman container with a headless GNOME Shell. Nothing changes on
the host system.

- Images: Fedora 44 (GNOME 50) and Ubuntu 24.04 (GNOME 46).
- Steps: install, wait for 3 runs, take a screenshot, check the picture
  reload (section 5.6), uninstall, check that the old wallpaper is back.

### 7.4 Resource and leak checks

"No memory leaks" means:

- No process stays in memory between runs.
- The peak memory of a run does not grow over many runs.
- Files and folders do not grow over many runs.

Checks:

1. Run the updater 1,000 times against a local fixture server. Do not use
   NEPTUN for this test. Record the peak RSS of each run. Pass: every run is
   below 120 MB, and the trend is flat.
2. After the 1,000 runs, count the files and bytes in the cache and runtime
   folders. Pass: the counts are the same as after run 10.
3. After the 1,000 runs, look for updater processes. Pass: none.
4. Run the real timer against NEPTUN for 24 hours. Record `MemoryPeak` of
   each run from systemd, and count errors in the journal. Pass: memory is
   flat, and every error has a known cause (for example, the network was down).

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
