// SPDX-License-Identifier: MIT
// File helpers for tests.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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

// Copies a folder and everything in it to a new folder.
export function copyTree(fromPath, toPath) {
    const from = Gio.File.new_for_path(fromPath), to = Gio.File.new_for_path(toPath);
    to.make_directory_with_parents(null);
    const children = from.enumerate_children('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    for (let info = children.next_file(null); info !== null; info = children.next_file(null)) {
        const name = info.get_name();
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            copyTree(from.get_child(name).get_path(), to.get_child(name).get_path());
        else from.get_child(name).copy(to.get_child(name), Gio.FileCopyFlags.NONE, null, null);
    }
    children.close(null);
}

const REPO = GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0])));

// Copies core/ and updater/ of the repository to a new temporary folder and imports
// the copy of the module at path (for example 'updater/run.js'). A test can then change
// the files of the copy after the import. The caller deletes the folder with removeTree.
export async function importCopy(path) {
    const folder = GLib.dir_make_tmp('air-raid-tree-XXXXXX');
    for (const name of ['core', 'updater'])
        copyTree(GLib.build_filenamev([REPO, name]), GLib.build_filenamev([folder, name]));
    const module = await import(GLib.filename_to_uri(GLib.build_filenamev([folder, path]), null));
    return {module, folder};
}
