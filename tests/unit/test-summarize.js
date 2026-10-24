// SPDX-License-Identifier: MIT
// tests/leak/summarize.js on small made-up inputs. Each test writes the input files to a
// new folder and runs summarize.js in a new process.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {test, run, assertEqual, assertTrue} from '../lib/assert.js';
import {removeTree} from '../lib/files.js';

const SUMMARIZE = GLib.filename_from_uri(
    GLib.Uri.resolve_relative(import.meta.url, '../leak/summarize.js', GLib.UriFlags.NONE))[0];

// files: {path in the folder: text}. In args, '@' is the folder. Returns the exit status
// and the output.
function summarize(files, args) {
    const dir = GLib.dir_make_tmp('air-raid-summarize-XXXXXX');
    try {
        for (const [name, text] of Object.entries(files)) {
            const path = GLib.build_filenamev([dir, name]);
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
            GLib.file_set_contents(path, text);
        }
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        const process = launcher.spawnv(['gjs', '-m', SUMMARIZE, ...args.map(arg => arg.replace('@', dir))]);
        const [, output] = process.communicate_utf8(null, null);
        return {status: process.get_exit_status(), output, lines: output.split('\n')};
    } finally {
        removeTree(dir);
    }
}

// "PASS" or "FAIL": the verdict of the one verdict line whose text starts with text.
function verdictOf({output, lines}, text) {
    const found = lines.filter(line => /^(PASS|FAIL): /.test(line) && line.slice(6).startsWith(text));
    assertEqual(found.length, 1, `verdict lines for "${text}" in:\n${output}`);
    return found[0].slice(0, 4);
}

test('a run that the time limit of run-many.sh stopped (exit 124) fails the exit check', () => {
    const result = summarize({'leak.txt': [
        '# 2026-10-24T00:00:00+00:00 gjs 1.88.1, display 1920x1080@1, 3 runs',
        '1 72000 0.17 0.02 0',
        '2 35000 0.02 0.00 124',
        '3 72100 0.17 0.02 0',
        '# runs that did not exit 0: 1',
    ].join('\n')}, ['@/leak.txt']);
    assertTrue(result.lines.includes('runs: 3; exit 0: 2; other exits: run 2 exit 124'), result.output);
    assertEqual(verdictOf(result, 'every run exits 0'), 'FAIL');
    assertEqual(result.status, 1, 'exit status');
});

await run();
