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
// A GC probe: three proven GC passes, then malloc_trim(0). The four samples are before the
// probe, after the first GC pass, after the third, and 5 s after the trim.
const GC_COLUMNS = ['epoch', 'elapsed_s', 'shell_pid', 'collected', 'gc_passes', 'trim', 'trim_detail',
    ...['before', 'gc1', 'gc3', 'trim'].flatMap(when => ['pss', 'anon', 'shmem', 'rss'].map(kind => `${kind}_${when}_kb`)),
    'end_epoch'];
const RUN_COLUMNS = ['start_epoch', 'unit', 'invocation', 'result', 'status', 'seconds', 'peak_bytes',
    'swap_peak_bytes', 'cpu_ns'];
const tsv = (columns, rows) => `# ${columns.join('\t')}\n${rows.map(row => `${row.join('\t')}\n`).join('')}`;
// One step of the free heap memory of gnome-shell: one 1920x1080 RGBA picture buffer.
const UNIT = 8100;

// A soak folder with a control and an updater role over 4 hours: a sample every 60 s, a GC
// probe every 30 minutes (7 probes: 3 in the first half, 4 in the second), and an updater
// run every 30 s, all with flat memory. Options of each role:
// shellCpu and groupCpu: the CPU use of gnome-shell and of all processes of its service
// (the Shell and its children), as a share of one core.
// raw: KB added to the raw samples and to the pre-trim samples of the probes, a function of
// the time in seconds.
// live: the post-trim anonymous PSS of each probe above its base, in units (an array of 7).
// probes: fields that replace the values of a good probe, by probe index.
// peakGrowth: the growth of MemoryPeak from the first to the last run, as a share.
function soakFiles({control = {}, updater = {}, peakGrowth = 0.005} = {}) {
    const start = 1793000000, seconds = 4 * 3600, first = 15, last = seconds - 15, peak = 36 * 1048576;
    const files = {};
    const roles = {
        control: {shellCpu: 0.02, groupCpu: 0.025, ...control},
        updater: {shellCpu: 0.023, groupCpu: 0.029, ...updater},
    };
    for (const [role, options] of Object.entries(roles)) {
        const {raw = () => 0, live = [], probes: replaced = {}} = options;
        const samples = [], probes = [], runs = [];
        for (let t = 0; t <= seconds; t += 60) {
            samples.push([start + t, t, 4242, 200000 + raw(t), 100000 + raw(t), 5000, 300000,
                (options.shellCpu * t).toFixed(2), 250000 + raw(t), 400000000, Math.round(options.groupCpu * t * 1e6),
                0, 0, '']);
        }
        for (let t = 1800, i = 0; t < seconds; t += 1800, i++) {
            const probe = {collected: 'true,true,true', gc_passes: 3, trim: 'ok', trim_detail: 'malloc_trim returned 1',
                ...replaced[i]};
            const anon = 80000 + (live[i] ?? 0) * UNIT;
            probes.push([start + t, t, 4242, probe.collected, probe.gc_passes, probe.trim, probe.trim_detail,
                200000 + raw(t), 100000 + raw(t), 5000, 300000,
                190000 + raw(t), 95000 + raw(t), 5000, 290000,
                189000 + raw(t), 94000 + raw(t), 5000, 289000,
                anon + 90000, anon, 5000, anon + 180000, start + t + 20]);
        }
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

// Check 5 judges the live memory of gnome-shell: the post-trim anonymous PSS of the probes.
// The largest value in the second half minus the largest value in the first half, minus the
// same rise of the control, must be at most 2 units.
const LIVE = 'updater: gnome-shell live memory';

test('a plateau of the live memory passes check 5', () => {
    // The level rises by 3 units in the first half, then moves in steps of one unit.
    const result = soak({updater: {live: [0, 2, 3, 2, 3, 3, 2]}});
    assertEqual(verdictOf(result, LIVE), 'PASS');
    assertTrue(result.output.includes('added rise 0 KB'), `the added rise in:\n${result.output}`);
    assertEqual(result.status, 0, 'exit status');
});

test('a steady climb of the live memory fails check 5', () => {
    // One unit per probe: the largest values are 2 units (first half) and 6 units (second half).
    const result = soak({updater: {live: [0, 1, 2, 3, 4, 5, 6]}});
    assertEqual(verdictOf(result, LIVE), 'FAIL');
    assertTrue(result.output.includes(`added rise ${4 * UNIT} KB`), `the added rise in:\n${result.output}`);
    assertEqual(result.status, 1, 'exit status');
});

test('check 5 subtracts the rise of the control from the rise of the updater', () => {
    // The updater rises by 3 units, the control by 2 units: the updater adds 1 unit.
    const result = soak({updater: {live: [0, 0, 0, 3, 3, 3, 3]}, control: {live: [0, 0, 0, 2, 2, 2, 2]}});
    assertEqual(verdictOf(result, LIVE), 'PASS');
    assertTrue(result.output.includes(`added rise ${UNIT} KB`), `the added rise in:\n${result.output}`);
    assertEqual(result.status, 0, 'exit status');
});

test('a failed trim fails the data check, and its sample does not count', () => {
    // Probe 4 has no trim; its sample is 10 units high. The other probes are flat.
    const result = soak({updater: {
        live: [0, 0, 0, 0, 10, 0, 0],
        probes: {4: {trim: 'fail', trim_detail: 'gdb is not installed on the host'}},
    }});
    assertEqual(verdictOf(result, 'data: updater: every GC probe has 3 proven GC passes and a good malloc_trim'), 'FAIL');
    assertTrue(result.lines.some(line => line.includes('2h30m') && line.includes('gdb is not installed on the host')),
        `the reason of the failed probe in:\n${result.output}`);
    assertEqual(verdictOf(result, 'data: control: every GC probe has 3 proven GC passes and a good malloc_trim'), 'PASS');
    assertEqual(verdictOf(result, LIVE), 'PASS');
    assertEqual(result.status, 1, 'exit status');
});

test('a probe with fewer than 3 proven GC passes fails the data check', () => {
    const result = soak({updater: {probes: {1: {collected: 'true,false,true', gc_passes: 2}}}});
    assertEqual(verdictOf(result, 'data: updater: every GC probe has 3 proven GC passes and a good malloc_trim'), 'FAIL');
    assertTrue(result.lines.some(line => line.includes('1h00m') && line.includes('2 of 3 GC passes proven')),
        `the reason of the failed probe in:\n${result.output}`);
    assertEqual(result.status, 1, 'exit status');
});

test('the raw and the one-GC trends are printed, but not judged', () => {
    // The raw samples and the pre-trim samples climb by 20 units in 4 hours; the live memory is flat.
    const result = soak({updater: {raw: t => Math.round(20 * UNIT * t / (4 * 3600))}});
    assertEqual(result.lines.filter(line => line.startsWith('FAIL')).length, 0, `FAIL lines in:\n${result.output}`);
    assertTrue(result.lines.some(line => /^ {2}raw anonymous PSS: trend 40500\.0 KB\/h, .*\(not judged\)$/.test(line)),
        `the raw trend in:\n${result.output}`);
    assertTrue(result.lines.some(line => /^ {2}one-GC anonymous PSS: trend 40500\.0 KB\/h, .*\(not judged\)$/.test(line)),
        `the one-GC trend in:\n${result.output}`);
    assertTrue(result.lines.some(line => line.includes('not judged') && line.includes('allocator retention') &&
        line.includes('docs/decisions/2026-10-25-shell-memory.md')), `the reason line in:\n${result.output}`);
    assertEqual(result.status, 0, 'exit status');
});

await run();
