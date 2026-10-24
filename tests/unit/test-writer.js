// SPDX-License-Identifier: MIT
import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {test, run, assertEqual, assertDeepEqual, assertTrue, assertThrows} from '../lib/assert.js';
import {DEFAULT_RELOAD_METHOD, RELOAD_METHODS, writePicture} from '../../updater/writer.js';

function solid(r, g, b, width = 8, height = 4) {
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, width, height);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(r / 255, g / 255, b / 255);
    cr.paint();
    cr.$dispose();
    return surface;
}

function centerOf(path) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    const pixels = pixbuf.new_subpixbuf(pixbuf.get_width() >> 1, pixbuf.get_height() >> 1, 1, 1).get_pixels();
    return [pixels[0], pixels[1], pixels[2]];
}

function listDir(dir) {
    const names = [];
    const children = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info = children.next_file(null); info; info = children.next_file(null))
        names.push(info.get_name());
    return names.sort();
}

function setModified(path, seconds) {
    Gio.File.new_for_path(path).set_attribute_uint64('time::modified', seconds, Gio.FileQueryInfoFlags.NONE, null);
}

function withDir(fn) {
    const dir = GLib.dir_make_tmp('air-raid-writer-XXXXXX');
    try {
        fn(dir);
    } finally {
        for (const name of listDir(dir))
            Gio.File.new_for_path(GLib.build_filenamev([dir, name])).delete(null);
        Gio.File.new_for_path(dir).delete(null);
    }
}

test('the default method is one of the methods', () => {
    assertDeepEqual(RELOAD_METHODS, ['in-place', 'rename', 'alternate']);
    assertTrue(RELOAD_METHODS.includes(DEFAULT_RELOAD_METHOD));
});

test('in-place writes picture.png and finishes the surface', () => withDir(dir => {
    const surface = solid(204, 26, 26);
    const path = writePicture(surface, dir, 'in-place');
    assertEqual(path, `${dir}/picture.png`);
    assertDeepEqual(centerOf(path), [204, 26, 26]);
    assertThrows(() => new Cairo.Context(surface), 'the surface is finished');
    assertEqual(writePicture(solid(26, 26, 204), dir, 'in-place'), path);
    assertDeepEqual(centerOf(path), [26, 26, 204]);
}));

test('rename replaces picture.png and leaves no temporary file', () => withDir(dir => {
    writePicture(solid(204, 26, 26), dir, 'rename');
    const path = writePicture(solid(26, 26, 204), dir, 'rename');
    assertEqual(path, `${dir}/picture.png`);
    assertDeepEqual(centerOf(path), [26, 26, 204]);
    assertDeepEqual(listDir(dir), ['picture.png']);
}));

// rename(2) in one folder: picture.png is a new file at once, and the old file loses
// its name. A reader that opened the old file still reads the whole old picture.
test('rename replaces the picture atomically with a new file', () => withDir(dir => {
    const path = writePicture(solid(204, 26, 26), dir, 'rename');
    const reader = Gio.File.new_for_path(path).read(null);
    try {
        const old = reader.query_info('unix::inode,unix::nlink', null);
        assertEqual(old.get_attribute_uint32('unix::nlink'), 1);
        writePicture(solid(26, 26, 204), dir, 'rename');
        const info = Gio.File.new_for_path(path).query_info('unix::inode', Gio.FileQueryInfoFlags.NONE, null);
        assertTrue(info.get_attribute_uint64('unix::inode') !== old.get_attribute_uint64('unix::inode'),
            'picture.png is a new file');
        assertEqual(reader.query_info('unix::nlink', null).get_attribute_uint32('unix::nlink'), 0,
            'the old file has no name');
        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(reader, null);
        const pixel = pixbuf.new_subpixbuf(pixbuf.get_width() >> 1, pixbuf.get_height() >> 1, 1, 1).get_pixels();
        assertDeepEqual([pixel[0], pixel[1], pixel[2]], [204, 26, 26], 'the reader of the old file');
        assertDeepEqual(centerOf(path), [26, 26, 204]);
        assertDeepEqual(listDir(dir), ['picture.png'], 'no temporary file');
    } finally {
        reader.close(null);
    }
}));

test('in-place and rename write the file name that the caller gives', () => withDir(dir => {
    assertEqual(writePicture(solid(204, 26, 26), dir, 'in-place', 'picture-1.png'), `${dir}/picture-1.png`);
    const path = writePicture(solid(26, 26, 204), dir, 'rename', 'picture-2.png');
    assertEqual(path, `${dir}/picture-2.png`);
    assertDeepEqual(centerOf(path), [26, 26, 204]);
    assertEqual(writePicture(solid(26, 204, 26), dir, 'rename', 'picture-2.png'), path);
    assertDeepEqual(centerOf(path), [26, 204, 26]);
    assertDeepEqual(listDir(dir), ['picture-1.png', 'picture-2.png']);
}));

test('a file name with a folder throws and finishes the surface', () => withDir(dir => {
    const surface = solid(1, 2, 3);
    assertThrows(() => writePicture(surface, dir, 'rename', 'sub/picture.png'));
    assertThrows(() => new Cairo.Context(surface), 'the surface is finished');
    assertDeepEqual(listDir(dir), []);
}));

test('a failed rename deletes the temporary file', () => withDir(dir => {
    // A non-empty folder named picture.png makes the move fail.
    GLib.mkdir_with_parents(`${dir}/picture.png`, 0o755);
    GLib.file_set_contents(`${dir}/picture.png/keep`, 'x');
    const surface = solid(1, 2, 3);
    try {
        assertThrows(() => writePicture(surface, dir, 'rename'));
        assertThrows(() => new Cairo.Context(surface), 'the surface is finished');
        assertDeepEqual(listDir(dir), ['picture.png']);
    } finally {
        Gio.File.new_for_path(`${dir}/picture.png/keep`).delete(null);
        Gio.File.new_for_path(`${dir}/picture.png`).delete(null);
    }
}));

test('alternate writes over the older of two files', () => withDir(dir => {
    const a = `${dir}/picture-a.png`, b = `${dir}/picture-b.png`;
    assertEqual(writePicture(solid(204, 26, 26), dir, 'alternate'), a);
    assertEqual(writePicture(solid(26, 26, 204), dir, 'alternate'), b, 'a missing file comes first');
    setModified(a, 1000);
    setModified(b, 2000);
    assertEqual(writePicture(solid(26, 204, 26), dir, 'alternate'), a);
    assertDeepEqual(centerOf(a), [26, 204, 26]);
    setModified(a, 3000);
    assertEqual(writePicture(solid(204, 204, 26), dir, 'alternate'), b);
    assertDeepEqual(listDir(dir), ['picture-a.png', 'picture-b.png']);
}));

test('a relative folder gives an absolute path', () => withDir(dir => {
    const cwd = GLib.get_current_dir();
    GLib.chdir(dir);
    try {
        assertEqual(writePicture(solid(1, 2, 3), 'sub', 'in-place'), `${dir}/sub/picture.png`);
    } finally {
        GLib.chdir(cwd);
    }
    Gio.File.new_for_path(`${dir}/sub/picture.png`).delete(null);
    Gio.File.new_for_path(`${dir}/sub`).delete(null);
}));

test('an unknown method throws and finishes the surface', () => withDir(dir => {
    const surface = solid(1, 2, 3);
    assertThrows(() => writePicture(surface, dir, 'copy'));
    assertThrows(() => new Cairo.Context(surface), 'the surface is finished');
    assertDeepEqual(listDir(dir), []);
}));

test('a folder that cannot be created throws', () => withDir(dir => {
    GLib.file_set_contents(`${dir}/file`, 'x');
    assertThrows(() => writePicture(solid(1, 2, 3), `${dir}/file/sub`, 'in-place'));
}));

run();
