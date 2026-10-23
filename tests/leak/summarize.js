// SPDX-License-Identifier: MIT
// Evaluates the leak checks (spec 7.4, plan Task 11). It works for any number of
// runs and any soak duration.
//
// gjs -m tests/leak/summarize.js [--peak-limit <KB>] <run-many output>
//   Reads the output of tests/leak/run-many.sh: "<run> <peak KB> <user s> <sys s> <exit>"
//   lines ("#" lines are notes). Prints the maximum peak, the least-squares trend
//   in KB per 100 runs, and the maximum CPU time (user + sys) of one run.
//   Pass: every run exits 0; the trend is less than 1 % of the mean peak per 100
//   runs; each run uses less than 1 s of CPU time; with --peak-limit, every peak
//   is below the limit. The file checks of run-many.sh are its "# files:" line.
//
// gjs -m tests/leak/summarize.js --soak <updater-dir> <control-dir>
//   Reads the output folders of the soak (tests/leak/soak.sh): samples.tsv in
//   both folders, runs.tsv and journal.txt in the updater folder.
//   Updater: the runs and their results, the updater messages in the journal, the
//   MemoryPeak of each run (systemd) and its trend, and the CPU time of all runs.
//   gnome-shell: the PSS trend after the warm-up and the CPU time, for the updater
//   container and for the control container.
//   Pass for the updater: the peak trend is less than 1 % of the mean peak per 100
//   runs; the CPU time of all runs is less than 1 % of the duration (864 s in 24
//   hours, goal 6). Each run that did not succeed is listed with a REVIEW line: its
//   cause must be known (spec 7.4, check 4). REVIEW does not change the exit status.
//   Pass for gnome-shell (spec 7.4, check 5): the PSS trend of the updater container
//   minus the trend of the control, over the duration after the warm-up, is less
//   than 1 % of the control PSS (also for the anonymous part of PSS alone); and the
//   added CPU time is less than 1 % of one core.
//
// Exit status: 0 if every check passes, 1 if a check fails, 2 for a usage error.
import GLib from 'gi://GLib';
import System from 'system';

const usage = () => {
    printerr('usage: summarize.js [--peak-limit <KB>] <run-many output>\n' +
        '       summarize.js --soak <updater-dir> <control-dir>');
    System.exit(2);
};

const readText = path => new TextDecoder().decode(GLib.file_get_contents(path)[1]);
const readLines = path => readText(path).split('\n').filter(line => line.trim() && !line.startsWith('#'));
const fixed = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

// Least-squares slope of y over x.
function slope(xs, ys) {
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - mx) * (ys[i] - my);
        den += (xs[i] - mx) ** 2;
    }
    return den > 0 ? num / den : 0;
}

function maxBy(items, key) {
    return items.reduce((best, item) => (key(item) > key(best) ? item : best));
}

let failed = false;
function verdict(ok, text) {
    if (!ok) failed = true;
    print(`${ok ? 'PASS' : 'FAIL'}: ${text}`);
}

function runMany(path, peakLimit) {
    const runs = readLines(path).map(line => {
        const [run, peak, user, sys, exit] = line.trim().split(/\s+/).map(Number);
        if (![run, peak, user, sys, exit].every(Number.isFinite))
            throw new Error(`${path}: bad line: ${line}`);
        return {run, peak, cpu: user + sys, exit};
    });
    if (runs.length < 2) throw new Error(`${path}: fewer than 2 runs`);
    const peaks = runs.map(r => r.peak);
    const top = maxBy(runs, r => r.peak);
    const busiest = maxBy(runs, r => r.cpu);
    const meanPeak = mean(peaks);
    const trend = slope(runs.map(r => r.run), peaks) * 100;
    const bad = runs.filter(r => r.exit !== 0);
    print(`runs: ${runs.length}; exit 0: ${runs.length - bad.length}; other exits: ` +
        (bad.length ? bad.slice(0, 10).map(r => `run ${r.run} exit ${r.exit}`).join(', ') : 'none'));
    print(`peak KB: max ${top.peak} (run ${top.run}), mean ${fixed(meanPeak)}, min ${Math.min(...peaks)}`);
    for (let start = 0; start < runs.length; start += 100) {
        const block = runs.slice(start, start + 100);
        print(`  runs ${block[0].run}-${block[block.length - 1].run}: mean peak ${fixed(mean(block.map(r => r.peak)))} KB, ` +
            `max ${Math.max(...block.map(r => r.peak))} KB, mean CPU ${fixed(mean(block.map(r => r.cpu)), 3)} s`);
    }
    print(`trend: ${trend >= 0 ? '+' : ''}${fixed(trend)} KB per 100 runs (${fixed(trend / meanPeak * 100, 3)} % of the mean peak)`);
    print(`CPU (user + sys) s: max ${fixed(busiest.cpu, 2)} (run ${busiest.run}), ` +
        `mean ${fixed(mean(runs.map(r => r.cpu)), 3)}, total ${fixed(runs.reduce((a, r) => a + r.cpu, 0))}`);
    verdict(bad.length === 0, 'every run exits 0');
    verdict(Math.abs(trend) < meanPeak / 100, 'the peak trend is less than 1 % of the mean peak per 100 runs');
    verdict(busiest.cpu < 1, 'each run uses less than 1 s of CPU time (user + sys)');
    if (peakLimit !== null)
        verdict(top.peak < peakLimit, `every peak is below ${peakLimit} KB`);
}

// A TSV file with a "# name name ..." header line; returns objects with number values.
function readTable(path) {
    const text = readText(path);
    const header = text.split('\n').find(line => line.startsWith('# '));
    if (!header) throw new Error(`${path}: no header line`);
    const names = header.slice(2).trim().split(/\s+/);
    return readLines(path).map(line => {
        const values = line.split('\t');
        return Object.fromEntries(names.map((name, i) => {
            const number = Number(values[i]);
            return [name, values[i] !== undefined && values[i] !== '' && Number.isFinite(number) ? number : values[i]];
        }));
    });
}

const hours = seconds => seconds / 3600;
const hms = seconds => {
    const s = Math.round(seconds);
    return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
};

// The samples of one container: PSS trend after the warm-up and CPU use.
function shellSummary(name, samples, warmup) {
    const alive = samples.filter(s => typeof s.shell_pid === 'number' && s.shell_pid > 0 && typeof s.shell_pss_kb === 'number');
    const pids = new Set(alive.map(s => s.shell_pid));
    const late = alive.filter(s => s.elapsed_s >= warmup);
    const use = late.length >= 2 ? late : alive;
    const first = alive[0], last = alive[alive.length - 1];
    const seconds = last.elapsed_s - first.elapsed_s;
    const result = {
        name, samples: samples.length, alive: alive.length, restarts: pids.size - 1,
        meanPss: mean(use.map(s => s.shell_pss_kb)),
        pssSlope: slope(use.map(s => hours(s.elapsed_s)), use.map(s => s.shell_pss_kb)),
        anonSlope: slope(use.map(s => hours(s.elapsed_s)), use.map(s => s.shell_pss_anon_kb)),
        groupSlope: slope(use.map(s => hours(s.elapsed_s)), use.map(s => s.group_pss_kb)),
        shellJournal: last.shell_journal_lines,
        seconds,
        cpu: last.shell_cpu_s - first.shell_cpu_s,
        groupCpu: (last.group_cpu_us - first.group_cpu_us) / 1e6,
        firstPss: first.shell_pss_kb, lastPss: last.shell_pss_kb,
        minPss: Math.min(...alive.map(s => s.shell_pss_kb)), maxPss: Math.max(...alive.map(s => s.shell_pss_kb)),
    };
    print(`${name}: ${samples.length} samples over ${hms(seconds)}; gnome-shell PID changes: ${result.restarts}; ` +
        `samples without gnome-shell: ${samples.length - alive.length}`);
    print(`  gnome-shell PSS KB: first ${first.shell_pss_kb}, last ${last.shell_pss_kb}, min ${result.minPss}, max ${result.maxPss}`);
    print(`  PSS trend after ${hms(warmup)} warm-up (${use.length} samples): gnome-shell ${fixed(result.pssSlope)} KB/h ` +
        `(anonymous part ${fixed(result.anonSlope)} KB/h), all processes of the shell service ${fixed(result.groupSlope)} KB/h`);
    print(`  CPU: gnome-shell ${fixed(result.cpu)} s (${fixed(result.cpu / seconds * 100, 3)} % of one core), ` +
        `shell service with its children ${fixed(result.groupCpu)} s (${fixed(result.groupCpu / seconds * 100, 3)} %)`);
    const metadata = alive.filter(s => typeof s.metadata_write_bytes === 'number');
    print(`  gnome-shell journal lines: ${result.shellJournal}; gvfsd-metadata write_bytes: ` +
        (metadata.length ? `${metadata[metadata.length - 1].metadata_write_bytes} at the end` : 'no gvfsd-metadata process'));
    return result;
}

function soak(updaterDir, controlDir) {
    const file = (dir, name) => GLib.build_filenamev([dir, name]);
    // PSS divides shared pages between all processes that map them, also across the
    // two containers. When one container stops, the PSS of the other jumps. Use only
    // the samples up to 30 s before the earlier of the two last samples.
    const allUpdater = readTable(file(updaterDir, 'samples.tsv'));
    const allControl = readTable(file(controlDir, 'samples.tsv'));
    const lastElapsed = samples => (samples.length ? samples[samples.length - 1].elapsed_s : 0);
    const cut = Math.min(lastElapsed(allUpdater), lastElapsed(allControl)) - 30;
    const updaterSamples = allUpdater.filter(s => s.elapsed_s <= cut);
    const controlSamples = allControl.filter(s => s.elapsed_s <= cut);
    const runs = readTable(file(updaterDir, 'runs.tsv')).filter(r => r.unit === 'gnome-air-raid-map.service');
    const banners = readTable(file(updaterDir, 'runs.tsv')).filter(r => r.unit === 'gnome-air-raid-map-failed.service');
    if (updaterSamples.length < 2 || controlSamples.length < 2) throw new Error('fewer than 2 samples');
    if (runs.length < 2) throw new Error('fewer than 2 updater runs');
    // duration: the samples of gnome-shell that are used; runTime: the whole time of
    // the sampler, in which it recorded the updater runs.
    const duration = updaterSamples[updaterSamples.length - 1].elapsed_s - updaterSamples[0].elapsed_s;
    const runTime = lastElapsed(allUpdater) - allUpdater[0].elapsed_s;
    // gnome-shell grows after its start; the trend counts after the first hour, or
    // after the first 10 % of a run that is shorter than 10 hours.
    const warmup = Math.min(3600, duration / 10);

    print(`soak: ${hms(duration)} (${duration} s); updater ${updaterDir}, control ${controlDir}`);
    print(`samples used: ${updaterSamples.length} of ${allUpdater.length} (updater), ` +
        `${controlSamples.length} of ${allControl.length} (control); the samples near the end are left out`);
    print('');
    print('updater runs (systemd, gnome-air-raid-map.service):');
    const bad = runs.filter(r => r.result !== 'success' || r.status !== 0);
    // systemd shows "[not set]" when the user manager has no memory controller: then
    // MemoryMax= does not apply either.
    const measured = runs.filter(r => typeof r.peak_bytes === 'number');
    const peaksMb = measured.map(r => r.peak_bytes / 1048576);
    const meanPeak = measured.length ? mean(peaksMb) : NaN;
    const trend = measured.length >= 2 ? slope(measured.map((r, i) => i + 1), peaksMb) * 100 : NaN;
    const perHour = measured.length >= 2
        ? slope(measured.map(r => hours(r.start_epoch - runs[0].start_epoch)), peaksMb) : NaN;
    const cpuTotal = runs.reduce((a, r) => a + r.cpu_ns / 1e9, 0);
    const busiest = maxBy(runs, r => r.cpu_ns);
    const longest = maxBy(runs, r => r.seconds);
    const gaps = runs.slice(1).map((r, i) => r.start_epoch - runs[i].start_epoch);
    print(`  runs: ${runs.length}; success: ${runs.length - bad.length}; failure banner runs: ${banners.length}; ` +
        `time between run starts: min ${fixed(Math.min(...gaps), 0)} s, max ${fixed(Math.max(...gaps), 0)} s`);
    for (const r of bad.slice(0, 20))
        print(`  not success: ${GLib.DateTime.new_from_unix_utc(r.start_epoch).format('%F %T')} UTC: result ${r.result}, status ${r.status}`);
    if (bad.length > 20) print(`  ... and ${bad.length - 20} more`);
    if (measured.length < runs.length)
        print(`  MemoryPeak is not set for ${runs.length - measured.length} of ${runs.length} runs: ` +
            'the user manager has no memory controller');
    if (measured.length)
        print(`  MemoryPeak MB: max ${fixed(Math.max(...peaksMb))}, mean ${fixed(meanPeak)}, min ${fixed(Math.min(...peaksMb))}; ` +
            `swap peak max ${fixed(Math.max(...measured.map(r => Number(r.swap_peak_bytes) || 0)) / 1048576)} MB`);
    const hourly = new Map();
    for (const r of runs) {
        const h = Math.floor(hours(r.start_epoch - runs[0].start_epoch));
        if (!hourly.has(h)) hourly.set(h, []);
        hourly.get(h).push(r);
    }
    for (const [h, block] of hourly)
        print(`    hour ${h}: ${block.length} runs, mean peak ${fixed(mean(block.map(r => Number(r.peak_bytes) / 1048576)))} MB, ` +
            `mean CPU ${fixed(mean(block.map(r => r.cpu_ns / 1e9)), 3)} s`);
    print(`  peak trend: ${fixed(trend, 2)} MB per 100 runs (${fixed(trend / meanPeak * 100, 3)} % of the mean), ` +
        `${fixed(perHour, 3)} MB per hour`);
    print(`  CPU: total ${fixed(cpuTotal)} s in ${runTime} s (${fixed(cpuTotal / runTime * 100, 3)} % of one core); ` +
        `max one run ${fixed(busiest.cpu_ns / 1e9, 2)} s; longest run ${fixed(longest.seconds, 2)} s`);
    const messages = new Map();
    let journalLines = 0;
    try {
        for (const line of readText(file(updaterDir, 'journal.txt')).split('\n')) {
            if (!line.trim()) continue;
            journalLines++;
            // The lines of the updater process: "... gjs[<pid>]: <message>".
            const match = /\s(?:gjs|gnome-air-raid-map)\[\d+\]: (.*)$/.exec(line);
            if (match) {
                const key = match[1].replace(/\d{2}:\d{2}(:\d{2})?/g, 'HH:MM');
                messages.set(key, (messages.get(key) || 0) + 1);
            }
        }
    } catch (e) {
        print(`  journal.txt: ${e.message}`);
    }
    print(`  journal: ${journalLines} lines; updater messages: ${[...messages.values()].reduce((a, b) => a + b, 0)}`);
    for (const [message, count] of [...messages].sort((a, b) => b[1] - a[1]).slice(0, 15))
        print(`    ${count} × ${message}`);
    print('');

    print('gnome-shell (spec 7.4, check 5):');
    const updater = shellSummary('updater container', updaterSamples, warmup);
    const control = shellSummary('control container', controlSamples, warmup);
    const addedTrend = updater.pssSlope - control.pssSlope;
    const addedAnon = updater.anonSlope - control.anonSlope;
    const addedGrowth = addedTrend * hours(duration - warmup);
    const addedAnonGrowth = addedAnon * hours(duration - warmup);
    const addedCpu = (updater.cpu / updater.seconds - control.cpu / control.seconds) * 100;
    const addedGroupCpu = (updater.groupCpu / updater.seconds - control.groupCpu / control.seconds) * 100;
    print(`  added by the updater: PSS trend ${fixed(addedTrend)} KB/h (anonymous part ${fixed(addedAnon)} KB/h); ` +
        `${fixed(addedGrowth)} KB after the warm-up (` +
        `${fixed(addedGrowth / control.meanPss * 100, 3)} % of the control PSS); CPU ${fixed(addedCpu, 3)} % of one core ` +
        `(with the children of the shell: ${fixed(addedGroupCpu, 3)} %)`);
    print('');

    verdict(measured.length === runs.length, 'updater: systemd records MemoryPeak for every run');
    verdict(Math.abs(trend) < meanPeak / 100, 'updater: the MemoryPeak trend is less than 1 % of the mean peak per 100 runs');
    verdict(cpuTotal < runTime / 100, `updater: the CPU time of all runs is less than 1 % of the time (${fixed(runTime / 100)} s)`);
    // Spec 7.4, check 4: a failed run passes when it has a known cause (for example,
    // the network was down). That needs a person: the line says REVIEW, and it does
    // not change the exit status.
    if (bad.length === 0)
        print('PASS: updater: every run exits 0');
    else
        print(`REVIEW: updater: ${bad.length} runs did not succeed (listed above); each needs a known cause ` +
            '(see journal.txt at the same time)');
    verdict(updater.restarts === 0 && control.restarts === 0 &&
        updater.alive === updater.samples && control.alive === control.samples, 'gnome-shell runs in both containers for the whole soak');
    verdict(addedGrowth < control.meanPss / 100, 'gnome-shell: no PSS trend that the control does not have (added growth less than 1 % of the control PSS)');
    // PSS also changes when other processes map the same library files (the other
    // container, the host). The anonymous part does not; it shows a leak more clearly.
    verdict(addedAnonGrowth < control.meanPss / 100, 'gnome-shell: the same for the anonymous part of PSS');
    verdict(addedCpu < 1, 'gnome-shell: the updater adds less than 1 % of one core');
}

const args = ARGV.slice();
try {
    if (args[0] === '--soak') {
        if (args.length !== 3) usage();
        soak(args[1], args[2]);
    } else {
        let peakLimit = null;
        if (args[0] === '--peak-limit') {
            peakLimit = Number(args[1]);
            if (!(peakLimit > 0)) usage();
            args.splice(0, 2);
        }
        if (args.length !== 1) usage();
        runMany(args[0], peakLimit);
    }
} catch (e) {
    printerr(`summarize.js: ${e.message}`);
    System.exit(2);
}
System.exit(failed ? 1 : 0);
