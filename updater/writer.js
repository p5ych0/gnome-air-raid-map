// SPDX-License-Identifier: MIT
// Writes the wallpaper picture so that GNOME Shell shows the new picture (spec 5.6).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// in-place:  write over picture.png.
// rename:    write picture.png.tmp, then rename it over picture.png.
// alternate: write picture-a.png and picture-b.png in turn. The caller sets
//            picture-uri to the returned path on each update.
export const RELOAD_METHODS = ['in-place', 'rename', 'alternate'];

// Chosen in docs/decisions/2026-10-23-picture-reload-method.md.
export const DEFAULT_RELOAD_METHOD = 'rename';

const PICTURE = 'picture.png';
const TEMPORARY = 'picture.png.tmp';
const ALTERNATES = ['picture-a.png', 'picture-b.png'];
// The IEND chunk: the last 12 bytes of every complete PNG file.
const PNG_END = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

// GJS ignores the result of cairo_surface_write_to_png, so a short write
// (for example, a full disk) gives no error. Check the end of the file.
export function writePng(surface, path) {
    surface.writeToPNG(path);
    const stream = Gio.File.new_for_path(path).read(null);
    try {
        stream.seek(-PNG_END.length, GLib.SeekType.END, null);
        const tail = stream.read_bytes(PNG_END.length, null).toArray();
        if (tail.length !== PNG_END.length || PNG_END.some((byte, i) => tail[i] !== byte))
            throw new Error(`The picture ${path} is incomplete`);
    } finally {
        stream.close(null);
    }
}

function modifiedTime(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            'time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_attribute_uint64('time::modified') * 1e6 +
            info.get_attribute_uint32('time::modified-usec');
    } catch (e) {
        return -1;
    }
}

// The file that GNOME does not show now: a missing file, or the older file.
function nextAlternate(dir) {
    const [a, b] = ALTERNATES.map(name => GLib.build_filenamev([dir, name]));
    return modifiedTime(b) < modifiedTime(a) ? b : a;
}

// Writes the surface as a PNG in dir with the reload method, then finishes the
// surface (also on an error). Returns the absolute path that the wallpaper must show.
export function writePicture(surface, dir, method) {
    try {
        if (!RELOAD_METHODS.includes(method))
            throw new Error(`Unknown reload method: ${method}`);
        const absDir = Gio.File.new_for_path(dir).get_path();
        if (GLib.mkdir_with_parents(absDir, 0o755) !== 0)
            throw new Error(`Cannot create the folder ${absDir}`);
        if (method === 'alternate') {
            const path = nextAlternate(absDir);
            writePng(surface, path);
            return path;
        }
        const path = GLib.build_filenamev([absDir, PICTURE]);
        if (method === 'in-place') {
            writePng(surface, path);
            return path;
        }
        const temporary = Gio.File.new_for_path(GLib.build_filenamev([absDir, TEMPORARY]));
        try {
            writePng(surface, temporary.get_path());
            temporary.move(Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch (e) {
            try {
                temporary.delete(null);
            } catch (deleteError) {
                if (!deleteError.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    logError(deleteError, `Cannot delete ${temporary.get_path()}`);
            }
            throw e;
        }
        return path;
    } finally {
        surface.finish();
    }
}
