// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {test, run, assertEqual, assertTrue, assertThrows} from '../lib/assert.js';
import {assertColorNear, pixelReaderFromPath} from '../lib/pixels.js';
import {removeTree} from '../lib/files.js';
import {drawBanner} from '../../updater/banner.js';

const WIDTH = 1200, HEIGHT = 360;

const near = (pixel, hex, tolerance) => {
    try { assertColorNear(pixel, hex, tolerance); return true; } catch (e) { return false; }
};

// Draws the banner in a temporary folder and gives fn(path, at) the file and a pixel reader.
function withBanner(fn) {
    const dir = GLib.dir_make_tmp('air-raid-banner-XXXXXX');
    try {
        const path = GLib.build_filenamev([dir, 'banner.png']);
        drawBanner(path);
        fn(path, pixelReaderFromPath(path));
    } finally {
        removeTree(dir);
    }
}

// The box {left, right, top, bottom} of the pixels near hex, or null.
function inkBox(at, hex) {
    let box = null;
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            if (!near(at(x, y), hex, 6)) continue;
            if (!box) box = {left: x, right: x, top: y, bottom: y};
            box.left = Math.min(box.left, x);
            box.right = Math.max(box.right, x);
            box.top = Math.min(box.top, y);
            box.bottom = Math.max(box.bottom, y);
        }
    }
    return box;
}

test('banner has the fixed size and background', () => withBanner((path, at) => {
    const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
    assertEqual(format && format.get_name(), 'png');
    assertEqual(width, WIDTH, 'width');
    assertEqual(height, HEIGHT, 'height');
    for (const [x, y] of [[5, 5], [WIDTH - 5, 5], [5, HEIGHT - 5], [WIDTH - 5, HEIGHT - 5]])
        assertColorNear(at(x, y), '#0e1722', 0);
    let title = false;
    for (let y = 100; y <= 160 && !title; y++) {
        for (let x = 0; x < WIDTH && !title; x++)
            title = near(at(x, y), '#f2c879', 6);
    }
    assertTrue(title, 'no #f2c879 pixel in rows 100..160');
}));

test('banner lines are centered, in order, and in their colors', () => withBanner((path, at) => {
    const boxes = ['#f2c879', '#e6edf5', '#a8bdcf'].map(hex => {
        const box = inkBox(at, hex);
        assertTrue(box, `no ${hex} pixels`);
        return box;
    });
    for (const [i, box] of boxes.entries()) {
        const center = (box.left + box.right) / 2;
        assertTrue(Math.abs(center - WIDTH / 2) <= 4, `line ${i + 1} is not centered: ${box.left}..${box.right}`);
    }
    assertTrue(boxes[0].bottom < boxes[1].top && boxes[1].bottom < boxes[2].top,
        `the lines are not in order: ${JSON.stringify(boxes)}`);
    assertTrue(boxes[0].right - boxes[0].left > 200, 'the title is too narrow');
    const top = boxes[0].top, bottom = HEIGHT - 1 - boxes[2].bottom;
    assertTrue(Math.abs(top - bottom) <= 4, `the text is not centered vertically: ${top} above, ${bottom} below`);
}));

test('drawBanner throws when it cannot write the file', () => {
    const dir = GLib.dir_make_tmp('air-raid-banner-XXXXXX');
    try {
        assertThrows(() => drawBanner(GLib.build_filenamev([dir, 'missing', 'banner.png'])));
    } finally {
        removeTree(dir);
    }
});

// GIO sends a GVfs metadata call for Gio.File.move, and gvfsd-metadata then writes
// $XDG_DATA_HOME/gvfs-metadata on the home disk (see "runs write no GVfs metadata" in
// test-run.js). The banner is written with rename(2), like the pictures of a run.
// A probe with Gio.File.move shows whether GVfs writes metadata on this machine.
const BANNER = GLib.Uri.resolve_relative(import.meta.url, '../../updater/banner.js', GLib.UriFlags.NONE);

// Runs argv in a new session bus (dbus-run-session) with XDG_DATA_HOME=data; true if it exits 0.
function inSession(argv, data) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDERR_MERGE | Gio.SubprocessFlags.STDOUT_PIPE});
    launcher.setenv('XDG_DATA_HOME', data, true);
    const process = launcher.spawnv(['dbus-run-session', '--', ...argv]);
    const [, output] = process.communicate_utf8(null, null);
    if (!process.get_successful()) throw new Error(`${argv.join(' ')}: ${output}`);
}

test('drawing the banner twice writes no GVfs metadata', () => {
    if (!GLib.find_program_in_path('dbus-run-session')) {
        print('# skip: no dbus-run-session, so no GVfs metadata check');
        return;
    }
    const dir = GLib.dir_make_tmp('air-raid-banner-XXXXXX');
    try {
        GLib.file_set_contents(`${dir}/a`, 'a');
        inSession(['gjs', '-c', `const Gio = imports.gi.Gio;
            Gio.File.new_for_path(ARGV[0]).move(Gio.File.new_for_path(ARGV[1]), Gio.FileCopyFlags.NONE, null, null);`,
        `${dir}/a`, `${dir}/b`], `${dir}/probe-data`);
        if (!GLib.file_test(`${dir}/probe-data/gvfs-metadata`, GLib.FileTest.IS_DIR)) {
            print('# skip: GVfs writes no metadata here (no GVfs, or no session bus)');
            return;
        }
        GLib.file_set_contents(`${dir}/draw.js`, `import {drawBanner} from '${BANNER}';
            drawBanner(ARGV[0]);
            drawBanner(ARGV[0]);`);
        inSession(['gjs', '-m', `${dir}/draw.js`, `${dir}/banner.png`], `${dir}/data`);
        assertTrue(GLib.file_test(`${dir}/banner.png`, GLib.FileTest.IS_REGULAR), 'no banner');
        assertTrue(!GLib.file_test(`${dir}/data/gvfs-metadata`, GLib.FileTest.EXISTS), 'GVfs wrote metadata');
    } finally {
        removeTree(dir);
    }
});

run();
