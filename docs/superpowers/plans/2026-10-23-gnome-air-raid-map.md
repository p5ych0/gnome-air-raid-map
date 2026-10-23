# GNOME Air Raid Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a GJS updater that draws the NEPTUN air-raid map as a PNG at the real size of each monitor, sets it as the GNOME wallpaper, and exits; a systemd user timer runs it every 30 seconds.

**Architecture:** `core/` holds GNOME-independent logic ported from `plasma-air-raid-map` (data rules, threat symbols, Cairo drawing, picture layout, view model). `updater/` holds one run: read the monitor layout over D-Bus, fetch and validate data with Soup, draw with Cairo and Pango, write the picture to `$XDG_RUNTIME_DIR`, set `org.gnome.desktop.background`, exit. `tests/gnome/` runs a headless GNOME Shell in Podman for integration and leak tests.

**Tech Stack:** GJS ES modules, libsoup 3, Cairo, Pango and PangoCairo, Gio (files, settings, D-Bus), GdkPixbuf (tests only), systemd user units, Bash, Podman.

**Spec:** `docs/superpowers/specs/2026-10-23-gnome-air-raid-map-design.md` (read it with this plan).

**Reference project:** `~/Work/map` (`p5ych0/plasma-air-raid-map` 0.2.2). Files named `MapData.js`, `ThreatSymbols.js`, `AlertMap.qml`, `AlertSource.qml`, and `tests/*.qml` are in `~/Work/map/package/contents/ui/` and `~/Work/map/tests/`.

## Global Constraints

- GNOME 46 and newer. Test on Fedora 44 (GNOME 50, GJS 1.88) and Ubuntu 24.04 (GNOME 46, GJS 1.80).
- GJS with ES modules (`gjs -m`). libsoup 3, Cairo, Pango, PangoCairo, Gio. No npm packages, no Python, no compiled code.
- `core/` must not import GTK, Clutter, St, Meta, or Shell.
- GET requests only. Poll no more often than once every 5 seconds. The timer period is 30 seconds. Each request has a 15-second timeout.
- Base URL `https://neptun.in.ua`. Tests override it with the environment variable `AIR_RAID_MAP_API_BASE`.
- The repository must not include NEPTUN GeoJSON files. Do not use the NEPTUN name or logo as the identity of the project.
- Every monitor area of the picture shows "Дані: neptun.in.ua" and "Дотримуйтеся офіційних сигналів тривоги."
- Text from the provider is plain text. It is never Pango markup (`Pango.Layout.set_text`, never `set_markup`).
- One run: less than 1 s of CPU time; peak memory less than 120 MB at 1920×1080 and less than 200 MB at the size cap.
- Size cap: 16,600,000 pixels per picture.
- Service limits: `MemoryMax=300M`, `TimeoutStartSec=25s`.
- No root access. Files only in `$XDG_RUNTIME_DIR`, `$XDG_CACHE_HOME`, `$XDG_STATE_HOME`, `$XDG_DATA_HOME`, `~/.config/systemd/user/`, all under the directory name `gnome-air-raid-map`.
- License MIT, `Copyright (c) 2026 p5ych0`.
- Commit messages: `feat:`, `fix:`, `docs:`, `test:`, `chore:`; end with the `Co-Authored-By:` trailer that the session supplies.
- Ukrainian strings in this plan are exact. Copy them as written.

## Review Focus

These inputs are likely to break the program for a real user. No other task covers them. Each line names the task that adds its test.

1. **Fractional scale** (125 %, 150 %): non-integer logical sizes can shift or cut the map by a pixel. Expected: the monitor rectangles tile the picture with no gap and no overlap. Test: Task 3, `fractional scale tiles exactly`.
2. **A captive portal or proxy returns HTTP 200 with HTML**: expected: the run treats it as a failed request (stale data), not as a crash. Test: Task 6, `html body is a failed request`.
3. **A truncated boundary cache file** (power loss during a write): expected: the next run downloads the boundaries again and draws. Test: Task 6, `corrupt cache is downloaded again`.
4. **Provider text with `&` or `<`** in a region name: expected: the text appears literally, and drawing does not fail. Test: Task 4, `markup characters render literally`.
5. **Many region-only reports on a small or portrait monitor**: expected: the list stops at the limit and shows "Ще повідомлень: N". No text goes off the monitor. Test: Task 4, `area list limit on portrait`.

## Delivery

- Task 0 creates the GitHub repository. It needs the owner's answer on visibility first.
- Work happens on branch `feat/updater` in a worktree (`superpowers:using-git-worktrees`).
- Pull requests, each through `watch-pr-skill:watch-prs`:
  - PR 1 after Task 6: core logic, network, and storage.
  - PR 2 after Task 10: GNOME harness, updater, units, and install.
  - PR 3 after Task 12: leak results, README, and screenshots.
- Use `superpowers:requesting-code-review` before each PR. Use `superpowers:verification-before-completion` before each claim that a task is done.

## File Structure

```
LICENSE, README.md, .gitignore, install.sh
core/mapdata.js       Data rules (port of MapData.js)
core/canvas.js        Canvas2D-style adapter over Cairo + PangoCairo
core/symbols.js       Threat silhouettes (port of ThreatSymbols.js)
core/layout.js        Monitor layout -> picture size and monitor rectangles
core/render.js        Map drawing for one monitor and for the whole picture
core/view.js          Feed state, stale rules, status text, render key
updater/version.js    VERSION constant
updater/display.js    Read the monitor layout over D-Bus
updater/net.js        Soup session and JSON requests
updater/store.js      XDG paths, JSON files, boundary cache
updater/wallpaper.js  org.gnome.desktop.background read and write
updater/writer.js     Write the PNG with the chosen reload method
updater/run.js        One run, with injectable dependencies
updater/main.js       Entry point for the systemd service
updater/banner.js     Failure banner PNG (install time)
updater/check-deps.js Dependency check (install time)
systemd/*.in          Unit templates
tests/run.sh          Unit test runner
tests/lib/            assert.js, pixels.js, fixture-server.js, fixtures.js
tests/unit/           test-*.js
tests/render-fixtures.js  Visual fixtures
tests/gnome/          Containerfiles, session.sh, scenarios, compare.js
tests/leak/           1,000-run check and 24-hour soak
docs/decisions/       Decision records from the GNOME experiments
```

---

### Task 0: GitHub repository

**Precondition:** ask the owner whether `p5ych0/gnome-air-raid-map` is public or private. Do not create it before the answer.

- [ ] **Step 1: Create the repository and push `main`**

Run: `gh repo create p5ych0/gnome-air-raid-map --<public|private> --source ~/Work/gnome-air-raid-map --push --description "Live Ukraine air-raid map as a GNOME wallpaper. Native, no browser."`
Expected: `gh repo view p5ych0/gnome-air-raid-map --json url` prints the URL, and `git log origin/main --oneline` shows the design and plan commits.

- [ ] **Step 2: Confirm the reviewers**

Run: `gh api repos/p5ych0/gnome-air-raid-map --jq .full_name`. Then tell the owner that Copilot code review must be on for the repository and that the Codex connector must be linked for the account (see the `watch-prs` skill). Record the answer in the PR 1 description.

---

### Task 1: Data rules and the test runner

**Files:**
- Create: `core/mapdata.js`, `tests/run.sh`, `tests/lib/assert.js`, `tests/unit/test-mapdata.js`, `LICENSE`, `.gitignore`, `README.md` (one-paragraph stub)

**Interfaces:**
- Produces (`core/mapdata.js`): `project(point: [lon, lat]) -> [x, y]`, `prepareGeometry(collection) -> {regions, keys, bounds}`, `parseSnapshot(payload, oblasts, raions) -> {raions, oblasts, count}`, `isStale(lastSuccess: number, now: number, failed: boolean) -> boolean`, `parseThreats(payload) -> {points, areas, count}`, `STALE_AFTER_MS = 90000`.
- Produces (`tests/lib/assert.js`): `test(name: string, fn: () => void | Promise<void>)`, `run() -> Promise<void>` (exits with status 1 if a test fails), `assertEqual(actual, expected, msg?)`, `assertDeepEqual(actual, expected, msg?)`, `assertTrue(value, msg?)`, `assertThrows(fn, msg?)`, `assertRejects(promise, pattern?: RegExp)`.

- [ ] **Step 1: Write `tests/run.sh` and `tests/lib/assert.js`**

`tests/run.sh` exports `TZ=UTC`, `LC_ALL=C.UTF-8`, `GSETTINGS_BACKEND=memory`, then runs `gjs -m` on each `tests/unit/test-*.js` and exits non-zero if one fails. Output per test: `ok - <name>` or `not ok - <name>: <error>`.

- [ ] **Step 2: Write the failing tests in `tests/unit/test-mapdata.js`**

Port every case of `tst_alertdata.qml` and `tst_threatdata.qml` with the same names, inputs, and expected values: `raionAndOblastKeysAreSeparate`, `fullSnapshotClearsEndedAlerts`, the four `invalidResponsesCannotBecomeAllClear` rows, `staleDataIsNeverPresentedAsCurrent`, `multipolygonPreservesIslandsAndHoles`, the eight `typesAndCounts` rows, `regionOnlyReportNeverBecomesAPoint`, `fullSnapshotRemovesFinishedThreats`, `optionalAndNewProviderFields`, the seven `malformedSnapshotIsNotAnEmptyMap` rows. Add:

```js
test('stale limit is 90 seconds', () => assertEqual(STALE_AFTER_MS, 90000));
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `tests/run.sh`
Expected: FAIL, `core/mapdata.js` not found.

- [ ] **Step 4: Create `core/mapdata.js`**

Copy `MapData.js`. Remove `.pragma library`. Add `export` to each function. Add `export const STALE_AFTER_MS = 90000;` and use it in `isStale`. Change nothing else.

- [ ] **Step 5: Run the tests and see them pass**

Run: `tests/run.sh`
Expected: every line starts with `ok`, exit status 0.

- [ ] **Step 6: Add the repository files and commit**

`.gitignore`: `/out/`, `/tests/leak/.cache/`, `/tests/gnome/out/`. `LICENSE`: MIT text with `Copyright (c) 2026 p5ych0`.

```bash
git add core tests LICENSE .gitignore README.md
git commit -m "feat: port the alert and threat data rules to GJS"
```

---

### Task 2: Canvas adapter and threat symbols

**Files:**
- Create: `core/canvas.js`, `core/symbols.js`, `tests/lib/pixels.js`, `tests/unit/test-canvas.js`, `tests/unit/test-symbols.js`

**Interfaces:**
- Produces (`core/canvas.js`): `parseColor(css: string) -> [r, g, b, a]` (components 0–1; accepts `#rrggbb` and `#aarrggbb`, alpha first as in QML); `class Canvas2D` with `constructor(cr: Cairo.Context)`, methods `save() restore() scale(x, y) translate(x, y) rotate(rad) beginPath() moveTo(x, y) lineTo(x, y) closePath() arc(x, y, r, a0, a1) fill() stroke() fillRect(x, y, w, h) fillText(text, x, y) strokeText(text, x, y)`, properties `fillStyle strokeStyle lineWidth lineJoin globalAlpha font textAlign textBaseline`.
- Produces (`core/symbols.js`): `draw(ctx: Canvas2D, type: string, size: number, color: string)`, `marker(ctx: Canvas2D, threat, x: number, y: number, size: number)`.
- Produces (`tests/lib/pixels.js`): `pixelAt(surface: Cairo.ImageSurface, x: number, y: number) -> [r, g, b]` (0–255; writes a temporary PNG and reads it with GdkPixbuf, because GJS Cairo surfaces have no pixel access), `assertColorNear(actual, hex: string, tolerance = 3)`.

Adapter rules (Canvas2D behavior that Cairo does not have):
- `fill()` and `stroke()` keep the path: use `fillPreserve()` and `strokePreserve()`. `beginPath()` calls `newPath()`.
- `fillRect()` starts a new path, fills the rectangle, and leaves the path empty.
- `globalAlpha` multiplies the alpha of every source color.
- `font` accepts `"<weight> <size>px <family>"` with an optional weight, for example `"600 14px sans-serif"`. Map it to a `Pango.FontDescription` with an absolute size.
- `textAlign`: `left` (default), `center`, `right`. `textBaseline`: `alphabetic` (default), `top`, `middle`.
- `fillText` and `strokeText` use one `Pango.Layout` with `set_text`. `strokeText` uses `PangoCairo.layout_path` and then `stroke`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test-canvas.js`:
```js
test('parses rgb and qml argb colors', () => {
  assertDeepEqual(parseColor('#cf4655').map(v => Math.round(v * 255)), [207, 70, 85, 255]);
  assertDeepEqual(parseColor('#de152331').map(v => Math.round(v * 255)), [21, 35, 49, 222]);
});
test('fill keeps the path for a following stroke', () => { /* 20x20 surface: rect 5..15 filled #ff0000, then lineWidth 4, stroke #0000ff without a new path; pixelAt(10,10) is red, pixelAt(5,10) is blue */ });
test('global alpha blends', () => { /* paint #000000, globalAlpha 0.5, fillRect #ffffff; pixelAt is near [128,128,128] */ });
test('center aligned text is centered', () => { /* 200x40 surface, font "20px sans-serif", textAlign center, textBaseline middle, fillText "Ж" at (100,20) white on black: some pixel within x 92..108 at y 20 is white, pixel (10,20) and (190,20) are black */ });
```

`tests/unit/test-symbols.js`:
```js
for (const type of ['uav','fpv','recon','missile','ballistic','kab','mig31k','unknown','future-type'])
  test(`draws ${type}`, () => { /* 40x40 black surface, marker(ctx, {type, advisory:false, heading:null, count:0}, 20, 20, 16); pixelAt(20,20) is white (fpv: pixelAt(20,20) is white from the center fillRect) */ });
test('advisory markers are blue', () => { /* marker with advisory:true; center pixel near #9ad6f7 */ });
test('group count is drawn below the icon', () => { /* count 3, size 16: some white pixel in rows y 30..38 */ });
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `tests/run.sh` — Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `core/canvas.js` and `tests/lib/pixels.js`**

- [ ] **Step 4: Create `core/symbols.js`**

Copy `ThreatSymbols.js`. Remove `.pragma library`. Export `draw` and `marker`. Change nothing else. If a test fails, fix the adapter, not the copy.

- [ ] **Step 5: Run the tests and see them pass** — Run: `tests/run.sh`, all `ok`.

- [ ] **Step 6: Commit** — `git commit -m "feat: draw threat symbols with Cairo through a Canvas2D adapter"`

---

### Task 3: Picture layout and display state

**Files:**
- Create: `core/layout.js`, `updater/display.js`, `tests/unit/test-layout.js`, `tests/unit/test-display.js`, `tests/unit/fixtures/displayconfig-two-monitors.txt`

**Interfaces:**
- `DisplayState`: `{mode: 'logical' | 'physical', monitors: [{x, y, width, height, scale, primary}]}`. `x`, `y`, `width`, `height` are layout units: logical pixels in `logical` mode, physical pixels in `physical` mode.
- `Layout`: `{width, height, monitors: [{x, y, width, height, scale}]}` in picture pixels. `scale` is picture pixels per logical pixel for that monitor.
- Produces (`core/layout.js`): `PIXEL_CAP = 16600000`; `pictureLayout(display: DisplayState, cap = PIXEL_CAP) -> Layout`; `parseDisplayOverride(text: string) -> DisplayState` (format `WxH@S[,WxH@S…]`, monitors side by side from x = 0, first is primary, logical mode, `WxH` in physical pixels).
- Produces (`updater/display.js`): `parseCurrentState(state: GLib.Variant) -> DisplayState`; `readDisplayState() -> DisplayState` (calls `GetCurrentState` on `org.gnome.Mutter.DisplayConfig`, `/org/gnome/Mutter/DisplayConfig`, session bus, 2-second timeout); `currentDisplay() -> DisplayState` (uses `parseDisplayOverride(AIR_RAID_MAP_DISPLAY)` if that variable is set, else `readDisplayState()`).

Layout algorithm (fixed by the spec):
```js
// k: picture pixels per layout unit.
k = display.mode === 'logical' ? Math.max(...monitors.map(m => m.scale)) : 1;
bbox = union of monitor rectangles; translate so that bbox starts at 0,0.
width = bbox.width * k; height = bbox.height * k;
c = width * height > cap ? Math.sqrt(cap / (width * height)) : 1;
// Round each monitor edge (left, top, right, bottom) separately, so neighbors share edges.
edge = v => Math.round(v * k * c);
monitor.scale = (display.mode === 'logical' ? k : m.scale) * c;
picture width/height = edge(bbox.width) / edge(bbox.height).
```

`parseCurrentState` rules: the variant type is `(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})`. `layout-mode` 1 is `logical`, 2 is `physical` (missing means `logical`). For each logical monitor, take its first physical monitor and the mode with `is-current` true. Transforms 1, 3, 5, 7 swap width and height. In `logical` mode, size = round(mode size / scale); in `physical` mode, size = mode size.

- [ ] **Step 1: Save the fixture**

`tests/unit/fixtures/displayconfig-two-monitors.txt` holds this text, captured from GNOME Shell 50.6 headless with `--virtual-monitor 1920x1080 --virtual-monitor 1080x1920`:

```
(uint32 2, [(('Meta-0', 'MetaVendor', 'MetaVirtualMonitor', '0x00'), [('1920x1080@60.000', 1920, 1080, 60.0, 1.0, [1.0, 1.25, 1.3333333730697632, 1.5, 1.6666666269302368, 2.0], {'is-current': <true>, 'is-preferred': <true>})], {'is-builtin': <false>, 'display-name': <'MetaVendor'>, 'is-for-lease': <false>, 'color-mode': <uint32 0>, 'supported-color-modes': <[uint32 0]>, 'rgb-range': <uint32 1>}), (('Meta-1', 'MetaVendor', 'MetaVirtualMonitor', '0x01'), [('1080x1920@60.000', 1080, 1920, 60.0, 1.0, [1.0, 1.25, 1.3333333730697632, 1.5, 1.6666666269302368, 2.0], {'is-current': <true>, 'is-preferred': <true>})], {'is-builtin': <false>, 'display-name': <'MetaVendor'>, 'is-for-lease': <false>, 'color-mode': <uint32 0>, 'supported-color-modes': <[uint32 0]>, 'rgb-range': <uint32 1>})], [(0, 0, 1.0, uint32 0, true, [('Meta-0', 'MetaVendor', 'MetaVirtualMonitor', '0x00')], @a{sv} {}), (1920, 0, 1.0, 0, false, [('Meta-1', 'MetaVendor', 'MetaVirtualMonitor', '0x01')], {})], {'layout-mode': <uint32 1>, 'supports-changing-layout-mode': <true>})
```

- [ ] **Step 2: Write the failing tests**

`tests/unit/test-layout.js` (`L(...rows)` is a local helper: it builds a logical-mode `DisplayState` from `[x, y, width, height, scale]` rows, and the first row is primary):
```js
test('single 1080p', () => assertDeepEqual(pictureLayout(L([0,0,1920,1080,1])),
  {width:1920, height:1080, monitors:[{x:0,y:0,width:1920,height:1080,scale:1}]}));
test('4K at 200 %', () => assertDeepEqual(pictureLayout(L([0,0,1920,1080,2])),
  {width:3840, height:2160, monitors:[{x:0,y:0,width:3840,height:2160,scale:2}]}));
test('landscape plus portrait', () => assertDeepEqual(pictureLayout(L([0,0,1920,1080,1],[1920,0,1080,1920,1])),
  {width:3000, height:1920, monitors:[{x:0,y:0,width:1920,height:1080,scale:1},{x:1920,y:0,width:1080,height:1920,scale:1}]}));
test('mixed scale uses the highest scale', () => assertDeepEqual(pictureLayout(L([0,0,1920,1080,1],[1920,0,1920,1080,2])),
  {width:7680, height:2160, monitors:[{x:0,y:0,width:3840,height:2160,scale:2},{x:3840,y:0,width:3840,height:2160,scale:2}]}));
test('fractional scale tiles exactly', () => { // Review Focus 1
  const l = pictureLayout(L([0,0,2048,1152,1.25],[2048,0,2048,1152,1.25]));
  assertDeepEqual([l.width, l.height], [5120, 1440]);
  assertEqual(l.monitors[0].x + l.monitors[0].width, l.monitors[1].x);
});
test('cap keeps the aspect ratio', () => {
  const l = pictureLayout(L([0,0,3840,2160,1],[3840,0,3840,2160,1],[7680,0,3840,2160,1]));
  assertTrue(l.width * l.height <= 16600000);
  assertTrue(Math.abs(l.width / l.height - 11520 / 2160) < 0.002);
  assertEqual(l.monitors[2].x + l.monitors[2].width, l.width);
});
test('physical mode scales text, not the picture', () => assertDeepEqual(
  pictureLayout({mode:'physical', monitors:[{x:0,y:0,width:3840,height:2160,scale:2,primary:true}]}),
  {width:3840, height:2160, monitors:[{x:0,y:0,width:3840,height:2160,scale:2}]}));
test('override string', () => assertDeepEqual(parseDisplayOverride('3840x2160@2,1080x1920@1'),
  {mode:'logical', monitors:[{x:0,y:0,width:1920,height:1080,scale:2,primary:true},{x:1920,y:0,width:1080,height:1920,scale:1,primary:false}]}));
```

`tests/unit/test-display.js`:
```js
test('parses the captured two-monitor state', () => {
  const v = GLib.Variant.parse(new GLib.VariantType('(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})'), fixtureText, null, null);
  assertDeepEqual(parseCurrentState(v), {mode:'logical', monitors:[
    {x:0,y:0,width:1920,height:1080,scale:1,primary:true}, {x:1920,y:0,width:1080,height:1920,scale:1,primary:false}]});
});
test('rotation swaps width and height', () => { /* same fixture text with the first logical monitor transform changed to uint32 1: monitor 0 is 1080x1920 */ });
test('logical size divides by scale', () => { /* fixture with the first logical monitor scale 2.0: monitor 0 is 960x540, scale 2 */ });
```

- [ ] **Step 3: Run the tests and see them fail** — Run: `tests/run.sh` — Expected: FAIL, modules not found.
- [ ] **Step 4: Implement `core/layout.js` and `updater/display.js`**
- [ ] **Step 5: Run the tests and see them pass** — Run: `tests/run.sh`, all `ok`.
- [ ] **Step 6: Commit** — `git commit -m "feat: compute the picture layout from the real monitor layout"`

---

### Task 4: Map drawing

**Files:**
- Create: `core/render.js`, `tests/lib/fixtures.js`, `tests/unit/test-render.js`, `tests/render-fixtures.js`

**Interfaces:**
- Consumes: `Canvas2D` (Task 2), `marker` (Task 2), `Layout` (Task 3), `prepareGeometry`, `parseSnapshot`, `parseThreats` (Task 1).
- `Geometry`: `{oblasts, raions}` (results of `prepareGeometry`), or `null` while no boundaries are loaded.
- `View`: `{alerts, threats, alertsStale, threatsStale, statusLines: [string, string]}`. `alerts` and `threats` are parse results or `null`. Task 5 builds it.
- Produces (`core/render.js`):
  - `mapTransform(bounds, width, height) -> {scale, ox, oy}`: the `onPaint` formula of `AlertMap.qml` (padding `max(24, min(w, h) * 0.055)`, `-100` height and `65` top offset), in logical pixels.
  - `toScreen(t, point) -> [x, y]`.
  - `visibleThreats(points, t, width, height) -> points`: drops points with `x < 0 || x > width || y < 80 || y > height - 60`.
  - `areaListLimit(textAreaHeight) -> number`: `Math.max(1, Math.floor((textAreaHeight - 120) / 64))`.
  - `areaItemText(entry) -> string`: `region + ' · ' + label`, plus `' ×' + count` if `count > 0`, plus `'\nСпостереження'` if `advisory`.
  - `drawMonitor(cr, rect, geometry, view)`: draws one monitor. `rect` is a `Layout` monitor.
  - `renderPicture(layout, geometry, view) -> Cairo.ImageSurface` (`RGB24`, `layout.width` × `layout.height`).
- Produces (`tests/lib/fixtures.js`): `syntheticGeometry()` (the square `[[22,44],[40,44],[40,52],[22,52],[22,44]]`, key `test`, region `SYNTHETIC TEST DATA`, used as oblasts and raions), `syntheticThreats()` (the entries of `preview-threats.qml`), `syntheticView(overrides)`.

`drawMonitor` rules:
- `cr.save()`, clip to `rect`, `translate(rect.x, rect.y)`, `scale(rect.scale)`. Then draw in logical pixels with `w = rect.width / rect.scale` and `h = rect.height / rect.scale`. This keeps every constant of `AlertMap.qml` as it is.
- Map: copy `onPaint` of `AlertMap.qml` through `Canvas2D`: background `#0e1722`, oblast fill `#223448`, `globalAlpha` 0.4 when `alertsStale`, yellow `#c69235` before red `#cf4655`, raion strokes 0.5 `#456078`, oblast strokes 1.2 `#9ab1c6`, oblast labels (font `600 max(9, min(17, w/100))px sans-serif`, outline `#172431` width 3, fill `#eef4fa`, skip keys `м. київ` and `севастополь`), threat markers at `max(12, min(16, w/90))` only when `threats` is not null and `threatsStale` is false.
- Text area: the monitor rectangle inset by 64 logical pixels on each side.
- Text items: copy the `Text` items of `AlertMap.qml` (title with letter spacing 2, status top right with `view.statusLines`, centered stale message, region-only list, legend, attribution) with Pango layouts. Exceptions:
  - The attribution is "Дані: neptun.in.ua" (`neptun.in.ua` in `#8fc8ff`) and, on the second line, "Дотримуйтеся офіційних сигналів тривоги.".
  - Provider text uses `set_text`. Only the fixed legend and attribution may use markup.
  - Region-only items: rectangle `#de152331`, radius 5, padding 6, wrap, at most 3 lines, end ellipsis.
  - Status color: `#e5b45b` when either feed is stale, else `#a8bdcf`.

- [ ] **Step 1: Write the failing tests** (`tests/unit/test-render.js`; colors with `assertColorNear`; `L1080 = pictureLayout(parseDisplayOverride('1920x1080@1'))`; `t = mapTransform(syntheticGeometry().oblasts.bounds, 1920, 1080)`)

```js
test('background outside the map', () => { /* renderPicture 1920x1080 syntheticView(): pixel (5, 5) is #0e1722 */ });
test('red alert fills the oblast', () => { /* alerts parseSnapshot({oblasts:[{key:'test'}], raions:[]}): pixel at toScreen(t, project([24, 45])) is #cf4655 */ });
test('stale alerts are dimmed', () => { /* same with alertsStale:true: same pixel near [103, 59, 77] (0.4 red over #223448) */ });
test('stale threats are hidden', () => { /* threatsStale:true: no white pixel in a 20x20 box around each synthetic point */ });
test('off-map threats are dropped', () => assertEqual(visibleThreats([{point: project([60, 50])}], t, 1920, 1080).length, 0));
test('portrait keeps the whole map inside the monitor', () => { /* mapTransform(bounds, 1080, 1920): both corners of bounds map inside [0,1080]x[0,1920] */ });
test('each monitor gets its own map', () => { /* layout landscape+portrait: pixel at the map position of monitor 2 is #cf4655 with a red alert */ });
test('markup characters render literally', () => { // Review Focus 4
  assertEqual(areaItemText({region: 'A & <b>B', label: 'Ракета', count: 0, advisory: false}), 'A & <b>B · Ракета');
  renderPicture(L1080, syntheticGeometry(), syntheticView({threats: {points: [], count: 1,
    areas: [{region: 'A & <b>B', label: 'Ракета', count: 0, advisory: false}]}}));
});
test('area list limit on portrait', () => { // Review Focus 5
  assertEqual(areaListLimit(1920 - 128), 26);
  assertEqual(areaListLimit(150), 1);
});
```

- [ ] **Step 2: Run the tests and see them fail** — Run: `tests/run.sh` — Expected: FAIL, `core/render.js` not found.
- [ ] **Step 3: Implement `core/render.js` and `tests/lib/fixtures.js`**
- [ ] **Step 4: Run the tests and see them pass** — Run: `tests/run.sh`, all `ok`.
- [ ] **Step 5: Write `tests/render-fixtures.js <out-dir>`**

It writes 12 PNGs: sizes `1920x1080@1`, `3840x2160@2`, `2560x1080@1`, `1080x1920@1` × states `symbols`, `threat-outage` (threatsStale), `alerts-stale` (alertsStale, an alerts error). Every file name contains the size and the state.

- [ ] **Step 6: Inspect the fixtures**

Run: `gjs -m tests/render-fixtures.js out/fixtures` and read each PNG. Compare `1920x1080@1-symbols.png` with `~/Work/map/docs/images/kde-plasma-air-raid-map.png` for layout, colors, and text positions. Expected: the same layout; every text inside the monitor; no stretched map.

- [ ] **Step 7: Commit** — `git commit -m "feat: draw the alert map for each monitor with Cairo and Pango"`

---

### Task 5: View model and render key

**Files:**
- Create: `core/view.js`, `tests/unit/test-view.js`

**Interfaces:**
- `FeedState`: `{payload: object | null, lastSuccess: number, lastChange: number, digest: string, error: string}`. Empty: `{payload: null, lastSuccess: 0, lastChange: 0, digest: '', error: ''}`.
- Produces: `emptyFeed() -> FeedState`; `acceptFeed(feed, payload, now) -> FeedState` (sets `payload`, `lastSuccess = now`, `error = ''`; `digest` = SHA-256 of `JSON.stringify(payload)`; `lastChange = now` only if `digest` changed); `failFeed(feed, message) -> FeedState` (keeps `payload`, sets `error`); `buildView(alertsFeed, threatsFeed, geometry, now, labelMode: 'updated' | 'unchanged') -> View`; `renderKey(view, layout, geometryVersion: string) -> string` (SHA-256 of `JSON.stringify([view, layout, geometryVersion])`).

`buildView` rules:
- `alertsStale = isStale(alerts.lastSuccess, now, alerts.error !== '' || geometry === null)`; the same for threats without the geometry condition.
- `view.alerts = geometry && alerts.payload ? parseSnapshot(alerts.payload, geometry.oblasts, geometry.raions) : null`. If that parse throws, `alerts` is `null` and `alertsStale` is true.
- `view.threats = threats.payload ? parseThreats(threats.payload) : null`. If that parse throws, `threats` is `null` and `threatsStale` is true.
- The view holds no timestamps. Only `statusLines` carries time, so the render key changes only when the shown text changes.
- Time text `HH:MM` uses `GLib.DateTime.new_from_unix_local(ms / 1000).format('%H:%M')`. Mode `updated` uses `lastSuccess`. Mode `unchanged` uses `lastChange`.
- `statusLines[0]`: stale → `lastSuccess > 0 ? 'ДАНІ ЗАСТАРІЛИ' : 'ОЧІКУВАННЯ ДАНИХ'`; else `'Тривоги: оновлено ' + HH:MM` (`updated`) or `'Тривоги: без змін з ' + HH:MM` (`unchanged`).
- `statusLines[1]`: stale → `'Загрози: немає актуальних даних'`; else `'Загрози: оновлено ' + HH:MM + ' · ' + count + ' повідомл.'` or `'Загрози: без змін з ' + HH:MM + ' · ' + count + ' повідомл.'`.

- [ ] **Step 1: Write the failing tests** (`now = Date.UTC(2026, 9, 23, 14, 5, 30)`, `TZ=UTC`)

```js
test('fresh alerts show the update time', () => assertEqual(view(fresh).statusLines[0], 'Тривоги: оновлено 14:05'));
test('unchanged mode shows the change time', () => { /* lastChange = now - 600000: 'Тривоги: без змін з 13:55' */ });
test('failed request is stale at once', () => assertEqual(view(failFeed(fresh, 'HTTP 503')).statusLines[0], 'ДАНІ ЗАСТАРІЛИ'));
test('never loaded is waiting', () => assertEqual(view(emptyFeed()).statusLines[0], 'ОЧІКУВАННЯ ДАНИХ'));
test('90 seconds without success is stale', () => { /* lastSuccess = now - 90000, no error: alertsStale true */ });
test('threat outage leaves alerts current', () => { /* threats failed, alerts fresh: alertsStale false, threatsStale true, statusLines[1] 'Загрози: немає актуальних даних' */ });
test('failure keeps the last valid payload', () => { /* failFeed keeps payload; view.alerts is not null and alertsStale is true */ });
test('same payload keeps the change time', () => { /* acceptFeed twice with equal payloads at t1 and t2: lastChange t1, lastSuccess t2 */ });
test('updated mode changes the key every minute', () => { /* same feeds, now and now + 60000: keys differ */ });
test('unchanged mode keeps the key without changes', () => { /* labelMode 'unchanged', only lastSuccess moves by 60 s: keys equal */ });
test('layout change changes the key', () => { /* same view, two layouts: keys differ */ });
```

- [ ] **Step 2: Run the tests and see them fail** — Run: `tests/run.sh` — Expected: FAIL, `core/view.js` not found.
- [ ] **Step 3: Implement `core/view.js`**
- [ ] **Step 4: Run the tests and see them pass** — Run: `tests/run.sh`, all `ok`.
- [ ] **Step 5: Commit** — `git commit -m "feat: build the view, status text and render key from feed state"`

---

### Task 6: Network, storage and boundary cache

**Files:**
- Create: `updater/version.js`, `updater/net.js`, `updater/store.js`, `tests/lib/fixture-server.js`, `tests/unit/test-net.js`, `tests/unit/test-store.js`

**Interfaces:**
- Produces (`updater/version.js`): `VERSION = '0.1.0'`.
- Produces (`updater/net.js`): `apiBase() -> string` (`AIR_RAID_MAP_API_BASE` or `https://neptun.in.ua`, no trailing slash); `createSession({timeout = 15} = {}) -> Soup.Session` (user agent `gnome-air-raid-map/<VERSION>`); `getJson(session, url, {etag = null} = {}) -> Promise<{status: 200, json, etag: string | null} | {status: 304}>`. It rejects with `Error('HTTP <code>')`, `Error('Network timeout')` (`Gio.IOErrorEnum.TIMED_OUT`), or `Error('Invalid JSON')`.
- Produces (`updater/store.js`): `appPaths() -> {runtimeDir, cacheDir, stateDir, dataDir, statePath}` (each `<XDG dir>/gnome-air-raid-map`; throw `Error('XDG_RUNTIME_DIR is not set')` if that variable is missing); `readJson(path, fallback)`; `writeJsonAtomic(path, value)` (`Gio.File.replace_contents`, creates parent folders); `loadGeometry(session, base, cacheDir, now) -> Promise<{geometry, version}>` (`version` = `<oblasts etag>|<raions etag>`).
- Produces (`tests/lib/fixture-server.js`): `startServer(routes) -> {base: string, hits: Map<string, number>, setRoute(path, route), stop()}` with `route = {status = 200, body, etag = null, delayMs = 0}`. When the request's `If-None-Match` equals `etag`, the server answers 304. As a script: `gjs -m tests/lib/fixture-server.js <port> <dir>` serves `<dir>/oblasts.geojson`, `<dir>/raions.geojson`, `<dir>/threats.json` at `/api/v1/threats`, and alternates `/api/v1/alerts` between `<dir>/alerts-a.json` and `<dir>/alerts-b.json` on each request.

`loadGeometry` rules:
- Cache files: `oblasts.geojson`, `raions.geojson`, `geometry.json` (`{oblasts: {etag, checkedAt}, raions: {etag, checkedAt}}`).
- A file checked less than 3,600,000 ms ago is used without a request.
- An older file gets a request with `If-None-Match`. 304 updates `checkedAt`. 200 replaces the file and the ETag.
- A missing file, or a file that `prepareGeometry` rejects, gets an unconditional request.
- A failed request with a valid cached file uses the cached file. A failed request without a valid file rejects.

- [ ] **Step 1: Write the failing tests**

`tests/unit/test-net.js`:
```js
test('200 returns json and etag', async () => { /* route {body:'{"a":1}', etag:'W/"x"'}: {status:200, json:{a:1}, etag:'W/"x"'} */ });
test('matching etag returns 304', async () => { /* same route, getJson(..., {etag:'W/"x"'}): {status:304} */ });
test('server error is a failed request', async () => assertRejects(getJson(s, base + '/503'), /^HTTP 503$/));
test('slow server times out', async () => { /* createSession({timeout: 1}), route delayMs 2000: rejects /^Network timeout$/ */ });
test('html body is a failed request', async () => { // Review Focus 2
  /* route {body:'<html>login</html>'}: rejects /^Invalid JSON$/ */ });
```

`tests/unit/test-store.js` (temporary folders from `GLib.dir_make_tmp`):
```js
test('first load downloads and caches', async () => { /* hits /oblasts.geojson 1, /raions.geojson 1; files exist */ });
test('fresh cache makes no request', async () => { /* second load at now + 60000: hits unchanged */ });
test('old cache revalidates with etag', async () => { /* load at now + 3600001: server answers 304, files unchanged, checkedAt updated */ });
test('changed server copy is downloaded', async () => { /* etag changed on server: new file content, new version string */ });
test('corrupt cache is downloaded again', async () => { // Review Focus 3
  /* truncate oblasts.geojson to 100 bytes, checkedAt fresh: load downloads it again and returns valid geometry */ });
test('offline with valid cache uses the cache', async () => { /* server stopped, cache older than 1 h: resolves with cached geometry */ });
test('atomic json round trip', () => { /* writeJsonAtomic then readJson: deep equal */ });
```

- [ ] **Step 2: Run the tests and see them fail** — Run: `tests/run.sh` — Expected: FAIL, modules not found.
- [ ] **Step 3: Implement `updater/version.js`, `updater/net.js`, `updater/store.js`, `tests/lib/fixture-server.js`**

Use `Gio._promisify(Soup.Session.prototype, 'send_and_read_async')`. `Soup.Session` decodes gzip by default. Set `If-None-Match` with `msg.get_request_headers().append()`.

- [ ] **Step 4: Run the tests and see them pass** — Run: `tests/run.sh`, all `ok`.
- [ ] **Step 5: Commit** — `git commit -m "feat: fetch NEPTUN data with Soup and cache the boundaries"`
- [ ] **Step 6: Open PR 1**

Use `superpowers:requesting-code-review`, then push `feat/updater` and open a pull request to `main` with an STE description (`writing-simplified-technical-english`). Then run `watch-pr-skill:watch-prs` until the merge gate. Continue on the same branch after the merge, rebased on `main`.

---

### Task 7: GNOME test harness and picture reload method

**Files:**
- Create: `tests/gnome/Containerfile.fedora44`, `tests/gnome/Containerfile.ubuntu2404`, `tests/gnome/session.sh`, `tests/gnome/run.sh`, `tests/gnome/scenarios/reload.sh`, `tests/gnome/scenarios/unit.sh`, `updater/writer.js`, `docs/decisions/2026-10-23-picture-reload-method.md`

**Interfaces:**
- Produces (`tests/gnome/run.sh`): `tests/gnome/run.sh <fedora44|ubuntu2404> <scenario> [virtual-monitor ...]`. It builds the image if needed, mounts the repository read-only at `/repo` and `tests/gnome/out/<image>-<scenario>/` at `/out`, and runs the scenario in a GNOME session.
- Produces (`tests/gnome/session.sh`): shell functions `shell_eval <js>`, `screenshot <path>`, `set_wallpaper <uri> <options>` for scenarios.
- Produces (`updater/writer.js`): `RELOAD_METHODS = ['in-place', 'rename', 'alternate']`; `writePicture(surface, dir, method) -> string` (the absolute path that the wallpaper must show).

Harness facts (proved on 2026-10-23 with Fedora 44 and GNOME Shell 50.6; keep all of them):
- Fedora image: `dnf -y install --setopt=install_weak_deps=False gnome-shell gjs libsoup3 pango cairo-gobject gsettings-desktop-schemas dbus-daemon glib2 mesa-dri-drivers mesa-libEGL google-noto-sans-fonts`.
- `podman run --rm --privileged`: GNOME 50 loads images through glycin, and glycin's `bwrap` sandbox fails without it. Rootless `--privileged` has only the user's rights.
- `-e XDG_RUNTIME_DIR=/tmp/xdg` on `podman run`, and `mkdir -m 700 -p /tmp/xdg` before `dbus-run-session`. Without it, `dconf` and the Shell use different change files and the Shell never sees new settings.
- In the session: `mkdir -p /run/dbus && dbus-daemon --system --fork` and `rm -rf /run/systemd/seats` (the Shell then uses its dummy login manager).
- `gnome-shell --headless --wayland --no-x11 --unsafe-mode --virtual-monitor WxH [...]`. Wait for the `org.gnome.Shell` name. Hide the overview with `Main.overview.hide()` through `org.gnome.Shell.Eval`.
- Screenshot: `org.gnome.Shell.Screenshot.Screenshot false false <path>`, then wait 3 s before the Shell stops.
- Ubuntu image: `gnome-shell gjs gir1.2-soup-3.0 gir1.2-pango-1.0 dbus dconf-service gsettings-desktop-schemas fonts-noto-core gnome-shell-extension-ubuntu-dock`; run the Shell with `--mode=ubuntu` so that the dock shows. Adjust the package names if the build fails, and record the changes in the Containerfile comment.

- [ ] **Step 1: Write the harness and `scenarios/unit.sh`**

`unit.sh` runs `/repo/tests/run.sh` inside the container.

- [ ] **Step 2: Run the unit tests on both GNOME versions**

Run: `tests/gnome/run.sh fedora44 unit && tests/gnome/run.sh ubuntu2404 unit`
Expected: all `ok` on GJS 1.88 and GJS 1.80.

- [ ] **Step 3: Write `updater/writer.js` and `scenarios/reload.sh`**

For each method, `reload.sh` does 100 updates. Each update writes a solid picture that alternates between `#cc1a1a` and `#1a1acc`, sets the wallpaper once (method `alternate`: on every update), takes screenshots every 250 ms for 2 s, and samples the center pixel. Pass for one update: the new color appears within 2 s, and no sample is black or another color. The scenario prints one line per method: `<method> <passed>/100`.

- [ ] **Step 4: Run the reload test on both images**

Run: `tests/gnome/run.sh fedora44 reload && tests/gnome/run.sh ubuntu2404 reload`
Expected: one result line per method per image.

- [ ] **Step 5: Record the decision**

`docs/decisions/2026-10-23-picture-reload-method.md`: the results table, the chosen method (the first in the order `in-place`, `rename`, `alternate` with 100/100 on both images), and the reason. If only `alternate` passes, add the dconf bytes per day from `stat ~/.config/dconf/user` before and after 100 updates, multiplied by 1,440, and stop for the owner (spec 5.6).

- [ ] **Step 6: Commit** — `git commit -m "test: add headless GNOME harness and choose the picture reload method"`

---

### Task 8: One updater run

**Files:**
- Create: `updater/wallpaper.js`, `updater/run.js`, `updater/main.js`, `tests/unit/test-run.js`, `tests/gnome/scenarios/run.sh`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces (`updater/wallpaper.js`): `KEYS = ['picture-uri', 'picture-uri-dark', 'picture-options', 'primary-color']`; `backgroundSettings() -> Gio.Settings` (`org.gnome.desktop.background`); `applyLive(settings, uri, options = 'spanned') -> boolean` (sets the three values only if one differs, then `Gio.Settings.sync()`; returns true if it changed something).
- Produces (`updater/run.js`): `runOnce({session, settings, display, paths, now, base, labelMode, reloadMethod, pictureOptions}) -> Promise<{drew: boolean, uri: string}>`.
- Produces (`updater/main.js`): the entry point. It reads `AIR_RAID_MAP_LABEL_MODE` (`updated` default, or `unchanged`) and `AIR_RAID_MAP_PICTURE_OPTIONS` (`spanned` default, or `zoom`), calls `runOnce` with real dependencies, and exits 0. It exits 1 with one `printerr` line on any error that `runOnce` rejects with.

`runOnce` follows spec section 5.4. Rules:
- A failed request (`HTTP …`, `Network timeout`, `Invalid JSON`, validation error) is not a run error. It goes into `failFeed`, and the run draws the stale state and exits 0.
- A run error (exit 1) is only: no display layout now and none in the state file, no geometry and no cache while `XDG_RUNTIME_DIR` exists, or an exception in drawing or writing.
- The state file holds `{version: 1, alerts: FeedState, threats: FeedState, layout, displayState, renderKey, picture}`.
- If `display()` throws, use `state.displayState`.
- If the render key and the picture file are both unchanged, do not draw, but still call `applyLive` (spec 5.4, step 10).
- After drawing: `cr.$dispose()` and `surface.finish()` before `writePicture` returns.

- [ ] **Step 1: Write the failing tests** (`tests/unit/test-run.js`; `now = Date.UTC(2026, 9, 23, 14, 5, 30)`; fixture server with `syntheticGeometry()` boundaries; memory settings `Gio.Settings.new_with_backend('org.gnome.desktop.background', Gio.memory_settings_backend_new())`; `display` returns `parseDisplayOverride('1920x1080@1')`)

```js
test('first run draws and sets the wallpaper', async () => { /* drew true; settings picture-uri === uri; picture-options 'spanned'; the PNG at uri is 1920x1080 */ });
test('same minute same data does not draw', async () => { /* second run at now + 20000: drew false */ });
test('failure banner is replaced by the live picture', async () => { /* set picture-uri to the banner and options 'centered'; run without changes: picture-uri is the live uri again, options 'spanned' */ });
test('threat outage draws stale threats and exits normally', async () => { /* /api/v1/threats returns 503: resolves, drew true, state threats.error 'HTTP 503' */ });
test('display failure uses the last layout', async () => { /* second run with display throwing: resolves with the same picture size */ });
test('no layout at all is a run error', async () => { /* empty state, display throwing: rejects */ });
test('layout change draws a new picture', async () => { /* second run with '1080x1920@1': drew true, picture 1080x1920 */ });
```

- [ ] **Step 2: Run the tests and see them fail** — Run: `tests/run.sh` — Expected: FAIL, modules not found.
- [ ] **Step 3: Implement `updater/wallpaper.js`, `updater/run.js`, `updater/main.js`**
- [ ] **Step 4: Run the tests and see them pass** — Run: `tests/run.sh`, all `ok`.
- [ ] **Step 5: Write `scenarios/run.sh` and run it against NEPTUN**

The scenario runs `gjs -m /repo/updater/main.js` three times, 30 s apart, and takes a screenshot after each run.
Run: `tests/gnome/run.sh fedora44 run 1920x1080`
Expected: three runs exit 0; the screenshots show the live map under the top bar; the corner time matches the run time.

- [ ] **Step 6: Commit** — `git commit -m "feat: run the updater once and set the GNOME wallpaper"`

---

### Task 9: Monitor layouts in GNOME

**Files:**
- Create: `tests/gnome/scenarios/layouts.sh`, `tests/gnome/compare.js`, `docs/decisions/2026-10-23-multi-monitor-mode.md`

**Interfaces:**
- Consumes: `runOnce` (Task 8) through `updater/main.js`; `pictureLayout` (Task 3).
- Produces (`tests/gnome/compare.js`): `gjs -m tests/gnome/compare.js <picture.png> <screen.png> <layout.json>`. For each monitor, it samples a 5 × 5 grid inside the monitor (skipping the top 48 logical pixels and the left 80 logical pixels, which the top bar and the Ubuntu dock cover). It maps each point from picture pixels to screenshot pixels by the ratio of the two sizes. It prints `<monitor> <matches>/25` and exits 1 if a sample differs by more than 12 in any channel.

Layouts (spec 5.6), with `--virtual-monitor` sizes:
1. `1920x1080`
2. `3840x2160`, then scale 2 with `ApplyMonitorsConfig`
3. `1080x1920`
4. `1920x1080 2560x1080`
5. `1920x1080 3840x2160`, then scale 2 on the second monitor

Set the scale with `org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig` (method 1, temporary), using the serial and mode IDs from `GetCurrentState`.

- [ ] **Step 1: Write `compare.js` and `layouts.sh`**

For each layout: run the updater, take a screenshot, run `compare.js`, save the screenshot as `out/layout-<n>.png`.

- [ ] **Step 2: Run the layouts on both images**

Run: `tests/gnome/run.sh fedora44 layouts && tests/gnome/run.sh ubuntu2404 layouts`
Expected: layouts 1–4 report 25/25 for each monitor on both images. Read every screenshot: one whole map per monitor, not stretched, all text inside the margins, no text under the top bar or the dock.

- [ ] **Step 3: Decide on layout 5**

If layout 5 passes, keep `spanned`. If it fails, run layout 5 again with `AIR_RAID_MAP_PICTURE_OPTIONS=zoom` and a primary-only layout, and record in the decision file that mixed-scale setups use the fallback (spec 5.6). If the dock covers text on Ubuntu, increase the left inset of the text area and record the new value.

- [ ] **Step 4: Commit** — `git commit -m "test: check single, rotated, wide and mixed-scale monitor layouts in GNOME"`

---

### Task 10: Failure banner, systemd units and install

**Files:**
- Create: `updater/banner.js`, `updater/check-deps.js`, `systemd/gnome-air-raid-map.service.in`, `systemd/gnome-air-raid-map.timer`, `systemd/gnome-air-raid-map-failed.service.in`, `install.sh`, `tests/gnome/scenarios/install.sh`, `tests/unit/test-banner.js`

**Interfaces:**
- Produces (`updater/banner.js`): `drawBanner(path)`. As a script: `gjs -m updater/banner.js <out.png>`. The PNG is 1200 × 360, background `#0e1722`, centered lines "НЕ ОНОВЛЮЄТЬСЯ" (34 px, bold, `#f2c879`), "Дані на шпалерах можуть бути застарілими" (20 px, `#e6edf5`), "Дотримуйтеся офіційних сигналів тривоги." (20 px, `#a8bdcf`).
- Produces (`updater/check-deps.js`): exits 0 if `Soup 3.0`, `Pango`, `PangoCairo`, `cairo`, and the schema `org.gnome.desktop.background` load. Otherwise it prints one line per missing item and exits 1.
- Produces (`install.sh`): `./install.sh` and `./install.sh --uninstall`.

Unit content:
- `gnome-air-raid-map.service.in`: `[Unit] Description=Air raid map wallpaper update`, `OnFailure=gnome-air-raid-map-failed.service`; `[Service] Type=oneshot`, `ExecStart=@GJS@ -m @APPDIR@/updater/main.js`, `MemoryMax=300M`, `TimeoutStartSec=25s`.
- `gnome-air-raid-map.timer`: `[Unit] PartOf=graphical-session.target`, `After=graphical-session.target`; `[Timer] OnActiveSec=1s`, `OnUnitActiveSec=30s`, `AccuracySec=1s`; `[Install] WantedBy=graphical-session.target`.
- `gnome-air-raid-map-failed.service.in`: `Type=oneshot` with four `ExecStart=@GSETTINGS@ set org.gnome.desktop.background …` lines: `picture-uri '@BANNER_URI@'`, `picture-uri-dark '@BANNER_URI@'`, `picture-options 'centered'`, `primary-color '#0e1722'`.

`install.sh` steps follow spec 5.8. Details:
- `APPDIR=${XDG_DATA_HOME:-$HOME/.local/share}/gnome-air-raid-map`. Copy `core/`, `updater/`, `LICENSE`. Draw the banner to `$APPDIR/banner.png`.
- Saved settings: `${XDG_STATE_HOME:-$HOME/.local/state}/gnome-air-raid-map/previous-wallpaper`, one line per key in `KEYS`, `key<TAB>value` with the value from `gsettings get`. Do not overwrite this file if it exists (a second install must keep the original wallpaper).
- Substitute `@GJS@`, `@GSETTINGS@` (from `command -v`), `@APPDIR@`, `@BANNER_URI@` with `sed`.
- Then `systemctl --user daemon-reload` and `systemctl --user enable --now gnome-air-raid-map.timer`.
- Uninstall: `systemctl --user disable --now gnome-air-raid-map.timer`, restore each saved key with `gsettings set`, delete the unit files, `$APPDIR`, the cache, state, and runtime folders, then `systemctl --user daemon-reload`.

- [ ] **Step 1: Write the failing banner test**

```js
test('banner has the fixed size and background', () => { /* drawBanner(tmp): PNG 1200x360, pixel (5,5) is #0e1722, some pixel in rows 100..160 is near #f2c879 */ });
```

- [ ] **Step 2: Run it and see it fail** — Run: `tests/run.sh` — Expected: FAIL, `updater/banner.js` not found.
- [ ] **Step 3: Implement `updater/banner.js` and `updater/check-deps.js`**
- [ ] **Step 4: Run the tests and see them pass** — Run: `tests/run.sh`, all `ok`.
- [ ] **Step 5: Write the units and `install.sh`, then check the units**

Run: `for f in systemd/*; do sed 's|@[A-Z_]*@|/usr/bin/true|g' "$f" > "/tmp/$(basename "${f%.in}")"; done; systemd-analyze --user verify /tmp/gnome-air-raid-map*.service /tmp/gnome-air-raid-map.timer`
Expected: no output, exit status 0.

- [ ] **Step 6: Write and run `scenarios/install.sh`**

The container has no systemd user manager. Put a stub `systemctl` first in `PATH` that appends its arguments to `/out/systemctl.log`. The scenario:
1. Sets a known wallpaper.
2. Runs `/repo/install.sh`.
3. Checks that the units exist with no `@…@` left, that the banner exists, and that the log has `--user enable --now gnome-air-raid-map.timer`.
4. Runs the service `ExecStart` line by hand and takes a screenshot (live map).
5. Runs the four failure `ExecStart` lines by hand and takes a screenshot (banner centered on `#0e1722`, any monitor layout).
6. Runs the service again and takes a screenshot (live map again).
7. Runs `/repo/install.sh --uninstall` and checks that the four keys equal the known values and that the folders are gone.

Run: `tests/gnome/run.sh fedora44 install 1920x1080 1080x1920 && tests/gnome/run.sh ubuntu2404 install 1920x1080`
Expected: every check passes; the screenshots show map, banner, map.

- [ ] **Step 7: Commit** — `git commit -m "feat: add failure banner, systemd user units and install script"`

- [ ] **Step 8: Open PR 2** — the same procedure as Task 6, Step 6.

---

### Task 11: Resource and leak checks

**Files:**
- Create: `tests/leak/fetch-geometry.sh`, `tests/leak/run-many.sh`, `tests/gnome/scenarios/soak.sh`, `tests/leak/summarize.js`, `docs/decisions/2026-10-23-label-mode.md`

**Interfaces:**
- Produces (`tests/leak/run-many.sh`): `tests/leak/run-many.sh <runs> <display-override>`. It starts the fixture server script on a free port with the real boundaries from `tests/leak/.cache/` and alternating alert payloads, so every run draws. It sets `AIR_RAID_MAP_API_BASE`, `AIR_RAID_MAP_DISPLAY`, `GSETTINGS_BACKEND=memory`, and temporary XDG folders. It runs `/usr/bin/time -f '%M %U %S' gjs -m updater/main.js` that many times and writes one line per run: `<run> <peak KB> <user s> <sys s> <exit>`.
- Produces (`tests/leak/summarize.js`): reads that file and prints the maximum peak, the least-squares trend in KB per 100 runs, and the maximum CPU time.

- [ ] **Step 1: Write `fetch-geometry.sh`**

It downloads `/oblasts.geojson`, `/raions.geojson`, and `/api/v1/threats` (as `threats.json`) from NEPTUN into `tests/leak/.cache/` (gitignored). It writes `alerts-a.json` as `{"raions":[],"oblasts":[]}` and `alerts-b.json` with every oblast key from `oblasts.geojson` at level `red`, so that the two payloads always differ. It never commits these files.

- [ ] **Step 2: Run 1,000 runs at 1080p and at the cap**

Run: `tests/leak/run-many.sh 1000 1920x1080@1 > out/leak-1080.txt && tests/leak/run-many.sh 1000 3840x2160@1,3840x2160@1 > out/leak-cap.txt`, then `gjs -m tests/leak/summarize.js out/leak-1080.txt` and the same for `out/leak-cap.txt`.
Expected: every exit is 0; maximum peak below 122,880 KB (1080p) and 204,800 KB (cap); the trend is less than 1 % of the mean per 100 runs; maximum user + sys time below 1 s.

- [ ] **Step 3: Check files and processes**

Run: `du -sb` and `find | wc -l` on the temporary XDG folders after run 10 and after run 1,000, then `pgrep -f updater/main.js`.
Expected: the same byte and file counts at run 10 and at run 1,000; `pgrep` finds nothing.

- [ ] **Step 4: Write `scenarios/soak.sh` and start the 24-hour soak**

Two containers start at the same time from the Fedora image, with `1920x1080`. Both record `gnome-shell` PSS (`/proc/<pid>/smaps_rollup`) and CPU time every 60 s. Only one runs the updater, every 30 s, against NEPTUN, with `/usr/bin/time` for each run. Run it in the background for 24 hours. Use a `Monitor` watch with checkpoints so that a crash is reported at once.

- [ ] **Step 5: Evaluate the soak and decide the label mode**

Pass for the updater: every run's peak is flat over 24 hours, every non-zero exit has a known cause, and the sum of user and sys time over 24 hours is less than 864 s (1 % of one core, goal 6). Pass for `gnome-shell` (spec 7.4, check 5): no upward PSS trend that the control does not have, and less than 1 % of one core added on average. If `gnome-shell` fails, set the default of `AIR_RAID_MAP_LABEL_MODE` to `unchanged` in `updater/main.js`, run the soak again, and report both results to the owner. Write `docs/decisions/2026-10-23-label-mode.md` with the numbers and the result.

- [ ] **Step 6: Commit** — `git commit -m "test: add the 1,000-run leak check and the 24-hour GNOME soak"`

---

### Task 12: README, screenshots and release

**Files:**
- Modify: `README.md`
- Create: `docs/images/gnome-air-raid-map.png`

- [ ] **Step 1: Take the README screenshot**

Use the Task 8 scenario at 1920×1080 against NEPTUN. Save the screenshot as `docs/images/gnome-air-raid-map.png`.

- [ ] **Step 2: Write the README with `writing-simplified-technical-english`**

Sections, in this order:
1. Title and one-paragraph description.
2. Original idea credit (FullyRealist/LivelyAirRaidAlert) and a link to `plasma-air-raid-map` for KDE Plasma 6.
3. Screenshot.
4. Requirements (GNOME 46 or newer, the packages that `check-deps.js` checks).
5. Install, uninstall, and what the installer changes.
6. What the picture shows, and the stale-data rules.
7. Multi-monitor behavior, with the result of Task 9.
8. Limits: a picture, not a live map; the maximum delay of 30 s plus the request time; the size cap.
9. "Live GNOME Shell extension: in development."
10. Development: `tests/run.sh`, `tests/gnome/run.sh`, the leak checks.
11. Data, terms (links to the NEPTUN developer page and terms), and the official-alerts notice.
12. Credits and license.

- [ ] **Step 3: Run all tests once more**

Run: `tests/run.sh && tests/gnome/run.sh fedora44 unit && tests/gnome/run.sh ubuntu2404 unit`
Expected: all `ok`.

- [ ] **Step 4: Commit and open PR 3** — `git commit -m "docs: add README and screenshot"`, then the same procedure as Task 6, Step 6.

- [ ] **Step 5: Finish the branch**

After the merge, use `superpowers:finishing-a-development-branch`. Tag `v0.1.0` only after the owner agrees.
