// SPDX-License-Identifier: MIT
// Helper of scenarios/reload.sh: measures how GNOME Shell shows a new picture
// with one reload method of updater/writer.js (spec 5.6).
// Usage (in the GNOME session): gjs -m reload.js <method> <updates> <out-dir>
// Prints "<method> <passed>/<updates>" and "#" lines with details.
//
// Update i writes a solid picture: #cc1a1a for odd i, #1a1acc for even i
// (update 0 is the start picture). Then the helper takes a screenshot every
// 250 ms for 2 s and samples the center of the primary monitor.
// Color rule (plan, Task 7): the center showed the old color before the
// write, the new color appears within 2 s and stays, and no sample is black or
// another color.
// Marker rule (added): a square at 3/4 of the monitor width and height has one
// of four colors (i % 4). It must show the marker of picture i - 1 before the
// write, and the marker of picture i whenever the center shows the new color.
// With two colors and two files in turn (method alternate), a stale cached
// copy of a file has the right color but the wrong marker.
// An update passes if it passes both rules.
import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import System from 'system';
import {readDisplayState} from '../../../updater/display.js';
import {writePicture} from '../../../updater/writer.js';

const [method, updatesArg, outDir] = ARGV;
const UPDATES = Number(updatesArg);
const COLORS = [[0x1a, 0x1a, 0xcc], [0xcc, 0x1a, 0x1a]];
const MARKERS = [[0x1a, 0xcc, 0x1a], [0xcc, 0xcc, 0x1a], [0x1a, 0xcc, 0xcc], [0xcc, 0x1a, 0xcc]];
const SAMPLE_MS = 250, WINDOW_MS = 2000, SETTLE_MS = 5000, TOLERANCE = 12, KEEP_FAILURES = 3;
const runtime = GLib.getenv('XDG_RUNTIME_DIR');
const pictureDir = GLib.build_filenamev([runtime, 'gnome-air-raid-map', method]);
const shotDir = GLib.build_filenamev([runtime, 'reload-shots', method]);
GLib.mkdir_with_parents(shotDir, 0o700);

const {monitors} = readDisplayState();
const width = Math.max(...monitors.map(m => m.x + m.width));
const height = Math.max(...monitors.map(m => m.y + m.height));
const primary = monitors.find(m => m.primary) ?? monitors[0];
const CENTER = [primary.x + (primary.width >> 1), primary.y + (primary.height >> 1)];
const MARK = [primary.x + (primary.width * 3 >> 2), primary.y + (primary.height * 3 >> 2)];

const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
const now = () => GLib.get_monotonic_time() / 1000;

function picture(i) {
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, width, height);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(...COLORS[i % 2].map(v => v / 255));
    cr.paint();
    cr.setSourceRGB(...MARKERS[i % 4].map(v => v / 255));
    cr.rectangle(MARK[0] - 32, MARK[1] - 32, 64, 64);
    cr.fill();
    cr.$dispose();
    return surface;
}

// Writes only the keys that change, in one change: when picture-uri and
// picture-uri-dark change in two writes, the Shell starts to load the first
// picture and then destroys it ("this._fileWatches is null" in the Shell log).
function setWallpaper(path) {
    const uri = GLib.filename_to_uri(path, null);
    const values = {'picture-options': 'spanned', 'picture-uri': uri, 'picture-uri-dark': uri};
    settings.delay();
    for (const [key, value] of Object.entries(values)) {
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    }
    settings.apply();
    Gio.Settings.sync();
}

const decode = bytes => new TextDecoder().decode(bytes);

// Bytes that dconf-service gave to write() since it started (0 if it does not run).
function dconfWritten() {
    const proc = Gio.File.new_for_path('/proc').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info = proc.next_file(null); info; info = proc.next_file(null)) {
        const pid = info.get_name();
        try {
            if (!/^\d+$/.test(pid) || decode(GLib.file_get_contents(`/proc/${pid}/comm`)[1]).trim() !== 'dconf-service')
                continue;
            return Number(/^wchar: (\d+)$/m.exec(decode(GLib.file_get_contents(`/proc/${pid}/io`)[1]))[1]);
        } catch (e) { /* the process ended */ }
    }
    return 0;
}

function dconfSize() {
    try {
        return Gio.File.new_for_path(`${GLib.get_user_config_dir()}/dconf/user`)
            .query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
    } catch (e) {
        return 0;
    }
}

function sleepUntil(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(ms - now())), () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function screenshot(path) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot',
            'org.gnome.Shell.Screenshot', 'Screenshot', new GLib.Variant('(bbs)', [false, false, path]),
            new GLib.VariantType('(bs)'), Gio.DBusCallFlags.NONE, 10000, null, (bus, result) => {
                try {
                    const [ok] = bus.call_finish(result).deepUnpack();
                    if (ok) resolve();
                    else reject(new Error(`screenshot failed: ${path}`));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function readPixels(path) {
    for (let attempt = 0; ; attempt++) {
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
            const at = ([x, y]) => [...pixbuf.new_subpixbuf(x, y, 1, 1).get_pixels().slice(0, 3)];
            return {center: at(CENTER), marker: at(MARK)};
        } catch (e) {
            if (attempt >= 4) throw e;
            GLib.usleep(100000);
        }
    }
}

const near = (rgb, ref) => rgb.every((v, k) => Math.abs(v - ref[k]) <= TOLERANCE);

function classify(rgb, oldRef, newRef) {
    if (near(rgb, newRef)) return 'new';
    if (near(rgb, oldRef)) return 'old';
    if (rgb.every(v => v <= 40)) return `black(${rgb})`;
    return `other(${rgb})`;
}

function deleteFile(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch (e) { /* already gone */ }
}

// Polls until the screen shows picture i or timeoutMs passes. Returns which
// parts of picture i the last screenshot showed.
async function waitForPicture(i, timeoutMs) {
    const end = now() + timeoutMs;
    const file = `${shotDir}/wait.png`;
    for (;;) {
        await screenshot(file);
        const {center, marker} = readPixels(file);
        const shown = {color: near(center, COLORS[i % 2]), marker: near(marker, MARKERS[i % 4])};
        if ((shown.color && shown.marker) || now() > end) return shown;
        await sleepUntil(now() + SAMPLE_MS);
    }
}

const clock = () => GLib.DateTime.new_now_local().format('%H:%M:%S.%f').slice(0, 12);

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[sorted.length >> 1] : NaN;
}

async function main() {
    // The start picture. Methods in-place and rename set the wallpaper only here.
    setWallpaper(writePicture(picture(0), pictureDir, method));
    const shown = await waitForPicture(0, 10000);
    if (!shown.color || !shown.marker)
        throw new Error('the start picture did not appear in 10 s');

    const rows = [], firstNew = [], took = [], slip = [];
    let passed = 0, colorPassed = 0, failuresKept = 0;
    const dconfBefore = dconfWritten();
    for (let i = 1; i <= UPDATES; i++) {
        // The screen must show picture i - 1 before the write.
        const start = await waitForPicture(i - 1, SETTLE_MS);
        const time = clock();
        const written = writePicture(picture(i), pictureDir, method);
        if (method === 'alternate') setWallpaper(written);
        const t0 = now();
        const samples = [];
        for (let k = 1; k <= WINDOW_MS / SAMPLE_MS; k++) {
            await sleepUntil(t0 + k * SAMPLE_MS);
            const file = `${shotDir}/${i}-${k}.png`;
            const at = now();
            await screenshot(file);
            samples.push({file, ms: Math.round(at - t0)});
            took.push(now() - at);
            slip.push(at - t0 - k * SAMPLE_MS);
        }
        const oldColor = COLORS[(i - 1) % 2], newColor = COLORS[i % 2];
        const oldMarker = MARKERS[(i - 1) % 4], newMarker = MARKERS[i % 4];
        for (const s of samples) {
            const {center, marker} = readPixels(s.file);
            s.center = classify(center, oldColor, newColor);
            s.marker = classify(marker, oldMarker, newMarker);
        }
        const first = samples.findIndex(s => s.center === 'new');
        const colorOk = start.color && first >= 0 &&
            samples.slice(0, first).every(s => s.center === 'old') &&
            samples.slice(first).every(s => s.center === 'new');
        const fresh = samples.every(s => s.center !== 'new' || s.marker === 'new');
        const pass = colorOk && start.marker && fresh;
        if (pass) passed++;
        if (colorOk) colorPassed++;
        if (first >= 0) firstNew.push(samples[first].ms);
        rows.push([i, time, pass ? 'pass' : 'FAIL', colorOk ? 'pass' : 'FAIL',
            start.color ? 'ok' : 'WRONG', start.marker ? 'ok' : 'WRONG', fresh ? 'ok' : 'STALE',
            first >= 0 ? samples[first].ms : '-',
            samples.map(s => `${s.ms}:${s.center}/${s.marker}`).join(' ')].join('\t'));

        if (i === 1 || (!pass && failuresKept < KEEP_FAILURES)) {
            const name = pass ? `reload-${method}` : `fail-${method}-${i}`;
            if (!pass) failuresKept++;
            samples.forEach((s, k) => {
                if (pass && k !== samples.length - 1) return;
                const dest = pass ? `${outDir}/${name}.png` : `${outDir}/${name}-${k + 1}.png`;
                Gio.File.new_for_path(s.file).copy(Gio.File.new_for_path(dest),
                    Gio.FileCopyFlags.OVERWRITE, null, null);
            });
        }
        samples.forEach(s => deleteFile(s.file));
    }
    deleteFile(`${shotDir}/wait.png`);
    const dconfBytes = dconfWritten() - dconfBefore;

    GLib.file_set_contents(`${outDir}/reload-${method}.tsv`,
        `${['update', 'time', 'result', 'color-rule', 'start-color', 'start-marker', 'marker',
            'first-new-ms', 'samples (ms:center/marker)'].join('\t')}\n${rows.join('\n')}\n`);
    print(`${method} ${passed}/${UPDATES}`);
    print(`# ${method}: color rule alone ${colorPassed}/${UPDATES}; ` +
        `first new color at median ${median(firstNew)} ms, max ${Math.max(...firstNew)} ms; ` +
        `screenshot call median ${Math.round(median(took))} ms, max ${Math.round(Math.max(...took))} ms; ` +
        `max sample delay ${Math.round(Math.max(...slip))} ms`);
    print(`# ${method}: dconf-service wrote ${dconfBytes} bytes in ${UPDATES} updates ` +
        `(${Math.round(dconfBytes * 1440 / UPDATES)} bytes per day at one update per minute); ` +
        `dconf user database ${dconfSize()} bytes`);
}

const loop = GLib.MainLoop.new(null, false);
let status = 0;
main().catch(e => {
    printerr(`reload ${method}: ${e.message}`);
    status = 1;
}).finally(() => loop.quit());
loop.run();
System.exit(status);
