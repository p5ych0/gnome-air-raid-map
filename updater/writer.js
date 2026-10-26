// SPDX-License-Identifier: MIT
// Writes the wallpaper picture so that GNOME Shell shows the new picture (spec 5.6).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// in-place:  write over <name> (picture.png if the caller gives no name).
// rename:    write <name>.tmp, then rename it over <name>.
// alternate: write picture-a.png and picture-b.png in turn, and ignore <name>.
//            The caller sets picture-uri to the returned path on each update.
export const RELOAD_METHODS = ['in-place', 'rename', 'alternate'];

// Chosen in docs/decisions/2026-10-23-picture-reload-method.md.
export const DEFAULT_RELOAD_METHOD = 'rename';

const PICTURE = 'picture.png';
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

// rename(2) and unlink(2). Do not use Gio.File.move or Gio.File.delete for the
// files of a run: with GVfs, GIO then also sends a metadata call, and
// gvfsd-metadata writes ~/.local/share/gvfs-metadata on the home disk at each
// update (Task 11: about 30 KB per run). The picture is in RAM so that repeated
// writes do not wear the disk (spec 5.5).
export function renameFile(from, to) {
    if (GLib.rename(from, to) === 0) return;
    // GJS gives no errno after GLib.rename, so check the usual causes.
    const folder = GLib.path_get_dirname(to);
    let reason = '';
    if (!GLib.file_test(from, GLib.FileTest.EXISTS | GLib.FileTest.IS_SYMLINK))
        reason = 'the source is missing';
    else if (!GLib.file_test(folder, GLib.FileTest.IS_DIR))
        reason = 'the target folder is missing';
    // W_OK | X_OK: rename(2) must write in the folder and search it.
    else if (GLib.access(folder, 2 | 1) !== 0)
        reason = 'the target folder is not writable';
    throw new Error(`Cannot rename ${from} to ${to}${reason ? `: ${reason}` : ''}`);
}

// Deletes the file at path. A missing file is not an error.
export function removeFile(path) {
    if (GLib.unlink(path) !== 0 && GLib.file_test(path, GLib.FileTest.EXISTS | GLib.FileTest.IS_SYMLINK))
        throw new Error(`Cannot delete ${path}`);
}

// The file that GNOME does not show now: a missing file, or the older file.
function nextAlternate(dir) {
    const [a, b] = ALTERNATES.map(name => GLib.build_filenamev([dir, name]));
    return modifiedTime(b) < modifiedTime(a) ? b : a;
}

// Writes the surface as a PNG file `name` in dir with the reload method, then
// finishes the surface (also on an error). Returns the absolute path that the
// wallpaper must show.
export function writePicture(surface, dir, method, name = PICTURE) {
    try {
        if (!RELOAD_METHODS.includes(method))
            throw new Error(`Unknown reload method: ${method}`);
        if (name === '' || name.includes('/'))
            throw new Error(`Not a file name: ${name}`);
        const absDir = Gio.File.new_for_path(dir).get_path();
        // Only the user can list the runtime folder.
        if (GLib.mkdir_with_parents(absDir, 0o700) !== 0)
            throw new Error(`Cannot create the folder ${absDir}`);
        // mkdir does not change a folder that exists: an older version made it with
        // mode 0755. A failed chmod does not stop the run, because the picture can
        // still be written.
        GLib.chmod(absDir, 0o700);
        if (method === 'alternate') {
            const path = nextAlternate(absDir);
            writePng(surface, path);
            return path;
        }
        const path = GLib.build_filenamev([absDir, name]);
        if (method === 'in-place') {
            writePng(surface, path);
            return path;
        }
        // The temporary file is in the same folder, so the rename is atomic.
        const temporary = GLib.build_filenamev([absDir, `${name}.tmp`]);
        try {
            writePng(surface, temporary);
            renameFile(temporary, path);
        } catch (e) {
            try {
                removeFile(temporary);
            } catch (removeError) {
                logError(removeError);
            }
            throw e;
        }
        return path;
    } finally {
        surface.finish();
    }
}
