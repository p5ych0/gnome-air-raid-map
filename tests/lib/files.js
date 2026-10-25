// SPDX-License-Identifier: MIT
// File helpers for tests.
import Gio from 'gi://Gio';

// Deletes a folder and everything in it.
export function removeTree(dirPath) {
    const folder = Gio.File.new_for_path(dirPath);
    const children = folder.enumerate_children('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    for (let info = children.next_file(null); info !== null; info = children.next_file(null)) {
        const child = folder.get_child(info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY) removeTree(child.get_path());
        else child.delete(null);
    }
    children.close(null);
    folder.delete(null);
}
