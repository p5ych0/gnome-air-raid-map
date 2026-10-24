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

// The columns of tests/gnome/soak-sampler.sh.
const SAMPLE_COLUMNS = ['epoch', 'elapsed_s', 'shell_pid', 'shell_pss_kb', 'shell_pss_anon_kb', 'shell_pss_shmem_kb',
    'shell_rss_kb', 'shell_cpu_s', 'group_pss_kb', 'group_mem_bytes', 'group_cpu_us', 'journal_lines',
    'shell_journal_lines', 'metadata_write_bytes'];
const GC_COLUMNS = ['epoch', 'elapsed_s', 'shell_pid', 'collected', 'pss_before_kb', 'anon_before_kb',
    'shmem_before_kb', 'rss_before_kb', 'pss_after_kb', 'anon_after_kb', 'shmem_after_kb', 'rss_after_kb'];
const RUN_COLUMNS = ['start_epoch', 'unit', 'invocation', 'result', 'status', 'seconds', 'peak_bytes',
    'swap_peak_bytes', 'cpu_ns'];
const tsv = (columns, rows) => `# ${columns.join('\t')}\n${rows.map(row => `${row.join('\t')}\n`).join('')}`;

// A soak folder with a control and an updater role over 4 hours: a sample every 60 s, a GC
// probe every 30 minutes, and an updater run every 30 s, all with flat memory.
// shellCpu and groupCpu: the CPU use of gnome-shell and of all processes of its service
// (the Shell and its children), as a share of one core.
// peakGrowth: the growth of MemoryPeak from the first to the last run, as a share.
function soakFiles({control = {shellCpu: 0.02, groupCpu: 0.025}, updater = {shellCpu: 0.023, groupCpu: 0.029},
    peakGrowth = 0.005} = {}) {
    const start = 1793000000, seconds = 4 * 3600, first = 15, last = seconds - 15, peak = 36 * 1048576;
    const files = {};
    for (const [role, cpu] of [['control', control], ['updater', updater]]) {
        const samples = [], probes = [], runs = [];
        for (let t = 0; t <= seconds; t += 60) {
            samples.push([start + t, t, 4242, 200000, 100000, 5000, 300000, (cpu.shellCpu * t).toFixed(2),
                250000, 400000000, Math.round(cpu.groupCpu * t * 1e6), 0, 0, '']);
        }
        for (let t = 1800; t < seconds; t += 1800)
            probes.push([start + t, t, 4242, 'true', 200000, 100000, 5000, 300000, 190000, 95000, 5000, 290000]);
        for (let t = first; role === 'updater' && t <= last; t += 30) {
            runs.push([start + t, 'gnome-air-raid-map.service', `run-${t}`, 'success', 0, '0.400',
                Math.round(peak * (1 + peakGrowth * (t - first) / (last - first))), 0, 200000000]);
        }
        files[`${role}/samples.tsv`] = tsv(SAMPLE_COLUMNS, samples);
        files[`${role}/gc.tsv`] = tsv(GC_COLUMNS, probes);
        files[`${role}/runs.tsv`] = tsv(RUN_COLUMNS, runs);
        files[`${role}/journal.txt`] = '';
    }
    return files;
}

const soak = options => summarize(soakFiles(options), ['--soak', '@']);

test('a soak with flat memory and little CPU use passes every check', () => {
    const result = soak();
    assertEqual(result.lines.filter(line => line.startsWith('FAIL')).length, 0, `FAIL lines in:\n${result.output}`);
    assertEqual(verdictOf(result, 'updater: gnome-shell: the updater adds less than 1 % of one core'), 'PASS');
    assertEqual(result.status, 0, 'exit status');
});

test('the gnome-shell CPU check judges the shell service with its children', () => {
    // gnome-shell alone adds 0.5 % of one core; with its children (the glycin image
    // loaders of the picture updates), the service adds 1.5 %.
    const result = soak({updater: {shellCpu: 0.025, groupCpu: 0.04}});
    assertTrue(result.lines.includes('  CPU: 0.500 % of one core (with the children of the shell: 1.500 %)'),
        `both CPU numbers in:\n${result.output}`);
    assertEqual(verdictOf(result, 'updater: gnome-shell: the updater adds less than 1 % of one core'), 'FAIL');
    assertEqual(result.status, 1, 'exit status');
});

test('the MemoryPeak check limits the growth over the whole soak', () => {
    // 3 % over 480 runs is 0.6 % per 100 runs, but more than 1 % over the whole soak.
    const result = soak({peakGrowth: 0.03});
    assertEqual(verdictOf(result, 'updater: the MemoryPeak'), 'FAIL');
    assertEqual(result.status, 1, 'exit status');
});

test('a MemoryPeak that falls over the soak passes, as in the gnome-shell checks', () => {
    const result = soak({peakGrowth: -0.03});
    assertEqual(verdictOf(result, 'updater: the MemoryPeak'), 'PASS');
    assertEqual(result.status, 0, 'exit status');
});

await run();
