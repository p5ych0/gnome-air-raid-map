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
// gjs -m tests/leak/summarize.js --soak [--expect <seconds>] <soak-dir>
//   Reads the output folder of tests/leak/soak.sh: control/ and one or two updater
//   roles (updater/, updater-unchanged/), each with samples.tsv, gc.tsv, runs.tsv,
//   journal.txt and soak-info.txt. Each updater role is checked against the control.
//   Data (any role): no "aborted" file; no gap between samples above 150 s; with
//   --expect, the samples cover the expected seconds (90 s slack).
//   Updater runs: no gap between run starts above 90 s (with the gaps from the first
//   sample to the first run and from the last run to the last sample); at least 90 %
//   of the runs that 30 s steps allow (one run of slack at the end); MemoryPeak
//   recorded for every run; the peak trend is less than 1 % of the mean peak per
//   100 runs; the CPU time of all runs
//   is less than 1 % of the time (864 s in 24 hours, goal 6). Each run that did not
//   succeed is listed with a REVIEW line: its cause must be known (spec 7.4, check
//   4). REVIEW does not change the exit status.
//   gnome-shell (spec 7.4, check 5): shell in both containers for the whole soak;
//   every GC probe ran; for the raw samples (every 60 s) and for the post-GC samples
//   (30 s after each GC probe), PSS and its anonymous part: the trend of the updater
//   container minus the trend of the control, over the time after the warm-up, gives
//   a growth of less than 1 % of the control PSS; the updater adds less than 1 % of
//   one core.
//
// Exit status: 0 if every check passes, 1 if a check fails, 2 for a usage error.
import GLib from 'gi://GLib';
import System from 'system';

const usage = () => {
    printerr('usage: summarize.js [--peak-limit <KB>] <run-many output>\n' +
        '       summarize.js --soak [--expect <seconds>] <soak-dir>');
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
// A missing file gives no rows.
function readTable(path, {optional = false} = {}) {
    if (optional && !GLib.file_test(path, GLib.FileTest.EXISTS)) return [];
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
const file = (dir, name) => GLib.build_filenamev([dir, name]);
const isDir = path => GLib.file_test(path, GLib.FileTest.IS_DIR);
const maxGap = (times) => Math.max(0, ...times.slice(1).map((t, i) => t - times[i]));

// Limits of the data checks (fix round 1 of Task 11).
const MAX_SAMPLE_GAP_S = 150;   // samples every 60 s
const MAX_RUN_GAP_S = 90;       // a run every 30 s
const MIN_RUN_SHARE = 0.9;      // of the runs that 30 s steps allow
const EXPECT_SLACK_S = 90;      // the last sample can be up to one step early

// Linear trend in KB per hour of y over the samples, and the growth over their span.
function trendOf(rows, x, y) {
    const use = rows.filter(r => typeof r[y] === 'number');
    if (use.length < 2) return {slope: NaN, points: use.length};
    return {slope: slope(use.map(r => hours(r[x])), use.map(r => r[y])), points: use.length};
}

// One container: the samples (cut at the end, see soak()), the GC probes, the runs.
function loadRole(dir, name) {
    const all = readTable(file(dir, 'samples.tsv'));
    const gc = readTable(file(dir, 'gc.tsv'), {optional: true});
    const runs = readTable(file(dir, 'runs.tsv'), {optional: true});
    let info = '';
    try {
        info = readText(file(dir, 'soak-info.txt'));
    } catch (e) {
        // An older soak has no soak-info.txt.
    }
    const label = /^label mode: (.*)$/m.exec(info);
    return {name, dir, all, gc, runs, label: label ? label[1] : null, samples: all};
}

// The samples of one container: PSS trends after the warm-up, the post-GC trends, CPU use.
function shellSummary(role, warmup) {
    const samples = role.samples;
    const alive = samples.filter(s => typeof s.shell_pid === 'number' && s.shell_pid > 0 && typeof s.shell_pss_kb === 'number');
    if (alive.length < 2) throw new Error(`${role.name}: fewer than 2 samples with gnome-shell`);
    const pids = new Set(alive.map(s => s.shell_pid));
    const late = alive.filter(s => s.elapsed_s >= warmup);
    const use = late.length >= 2 ? late : alive;
    const first = alive[0], last = alive[alive.length - 1];
    const seconds = last.elapsed_s - first.elapsed_s;
    const gcLate = role.gc.filter(g => g.elapsed_s >= warmup && g.elapsed_s <= role.cut);
    const result = {
        name: role.name, samples: samples.length, alive: alive.length, restarts: pids.size - 1,
        meanPss: mean(use.map(s => s.shell_pss_kb)),
        pss: trendOf(use, 'elapsed_s', 'shell_pss_kb'),
        anon: trendOf(use, 'elapsed_s', 'shell_pss_anon_kb'),
        group: trendOf(use, 'elapsed_s', 'group_pss_kb'),
        gcPss: trendOf(gcLate, 'elapsed_s', 'pss_after_kb'),
        gcAnon: trendOf(gcLate, 'elapsed_s', 'anon_after_kb'),
        gcProbes: role.gc.length,
        gcCollected: role.gc.filter(g => g.collected === 'true').length,
        shellJournal: last.shell_journal_lines,
        seconds,
        cpu: last.shell_cpu_s - first.shell_cpu_s,
        groupCpu: (last.group_cpu_us - first.group_cpu_us) / 1e6,
    };
    print(`${role.name}: ${samples.length} samples over ${hms(seconds)}; gnome-shell PID changes: ${result.restarts}; ` +
        `samples without gnome-shell: ${samples.length - alive.length}`);
    print(`  gnome-shell PSS KB: first ${first.shell_pss_kb}, last ${last.shell_pss_kb}, ` +
        `min ${Math.min(...alive.map(s => s.shell_pss_kb))}, max ${Math.max(...alive.map(s => s.shell_pss_kb))}; ` +
        `anonymous part: first ${first.shell_pss_anon_kb}, last ${last.shell_pss_anon_kb}`);
    print(`  raw trend after ${hms(warmup)} warm-up (${use.length} samples): PSS ${fixed(result.pss.slope)} KB/h, ` +
        `anonymous ${fixed(result.anon.slope)} KB/h, all processes of the shell service ${fixed(result.group.slope)} KB/h`);
    print(`  GC probes: ${result.gcProbes}, collected ${result.gcCollected}; post-GC trend after the warm-up ` +
        `(${gcLate.length} probes): PSS ${fixed(result.gcPss.slope)} KB/h, anonymous ${fixed(result.gcAnon.slope)} KB/h`);
    for (const g of role.gc)
        print(`    probe at ${hms(g.elapsed_s)}: collected ${g.collected}; PSS ${g.pss_before_kb} -> ${g.pss_after_kb} KB, ` +
            `anonymous ${g.anon_before_kb} -> ${g.anon_after_kb} KB`);
    print(`  CPU: gnome-shell ${fixed(result.cpu)} s (${fixed(result.cpu / seconds * 100, 3)} % of one core), ` +
        `shell service with its children ${fixed(result.groupCpu)} s (${fixed(result.groupCpu / seconds * 100, 3)} %)`);
    const metadata = alive.filter(s => typeof s.metadata_write_bytes === 'number');
    print(`  gnome-shell journal lines: ${result.shellJournal}; gvfsd-metadata write_bytes: ` +
        (metadata.length ? `${metadata[metadata.length - 1].metadata_write_bytes} at the end` : 'no gvfsd-metadata process'));
    return result;
}

// The data checks of one container (fix round 1, finding 1): the sample gaps and the duration.
function dataChecks(role, expect) {
    const times = role.all.map(s => s.epoch);
    const gap = maxGap(times);
    const duration = role.all.length ? role.all[role.all.length - 1].elapsed_s : 0;
    print(`  ${role.name}: ${role.all.length} samples, largest gap between samples ${gap} s, last sample at ${duration} s`);
    verdict(role.all.length >= 2 && gap <= MAX_SAMPLE_GAP_S,
        `data: ${role.name}: no gap between samples above ${MAX_SAMPLE_GAP_S} s (largest ${gap} s)`);
    if (expect !== null)
        verdict(duration >= expect - EXPECT_SLACK_S, `data: ${role.name}: the samples cover the expected ${expect} s (${duration} s)`);
}

// The runs of one updater role (spec 7.4, check 4, and goal 6).
function runChecks(role) {
    const runs = role.runs.filter(r => r.unit === 'gnome-air-raid-map.service');
    const banners = role.runs.filter(r => r.unit === 'gnome-air-raid-map-failed.service');
    const from = role.all[0].epoch, to = role.all[role.all.length - 1].epoch;
    const runTime = to - from;
    print(`updater runs of ${role.name} (label mode ${role.label ?? 'unknown'}; systemd, gnome-air-raid-map.service):`);
    if (runs.length === 0) {
        print('  no runs');
        verdict(false, `${role.name}: the timer runs the updater`);
        return;
    }
    const bad = runs.filter(r => r.result !== 'success' || r.status !== 0);
    // The gaps include the edges: the time from the first sample to the first run, and
    // from the last run to the last sample. A timer that stops is a gap at the end.
    const starts = runs.map(r => r.start_epoch);
    const gap = maxGap([from, ...starts, to]);
    const expectedRuns = runTime / 30;
    // systemd shows "[not set]" when the user manager has no memory controller: then
    // MemoryMax= does not apply either.
    const measured = runs.filter(r => typeof r.peak_bytes === 'number');
    const peaksMb = measured.map(r => r.peak_bytes / 1048576);
    const meanPeak = measured.length ? mean(peaksMb) : NaN;
    const trend = measured.length >= 2 ? slope(measured.map((r, i) => i + 1), peaksMb) * 100 : NaN;
    const perHour = measured.length >= 2
        ? slope(measured.map(r => hours(r.start_epoch - starts[0])), peaksMb) : NaN;
    const cpuTotal = runs.reduce((a, r) => a + r.cpu_ns / 1e9, 0);
    const busiest = maxBy(runs, r => r.cpu_ns);
    const longest = maxBy(runs, r => r.seconds);
    print(`  runs: ${runs.length} (${fixed(runs.length / expectedRuns * 100)} % of ${fixed(expectedRuns, 0)} possible in ` +
        `${runTime} s); success: ${runs.length - bad.length}; failure banner runs: ${banners.length}; ` +
        `largest gap between run starts (with the edges): ${gap} s`);
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
        const h = Math.floor(hours(r.start_epoch - starts[0]));
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
        for (const line of readText(file(role.dir, 'journal.txt')).split('\n')) {
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

    verdict(gap <= MAX_RUN_GAP_S, `${role.name}: no gap between run starts above ${MAX_RUN_GAP_S} s (largest ${gap} s)`);
    // One run of slack: the last run can still be in progress when the sampler ends
    // (a 300 s soak has 9 complete runs of 10.1 possible). In 24 hours one run is 0.03 %.
    verdict(runs.length + 1 >= MIN_RUN_SHARE * expectedRuns,
        `${role.name}: at least ${MIN_RUN_SHARE * 100} % of the possible runs, with one run of slack at the end ` +
        `(${runs.length} of ${fixed(expectedRuns, 1)})`);
    verdict(measured.length === runs.length, `${role.name}: systemd records MemoryPeak for every run`);
    verdict(Math.abs(trend) < meanPeak / 100, `${role.name}: the MemoryPeak trend is less than 1 % of the mean peak per 100 runs`);
    verdict(cpuTotal < runTime / 100, `${role.name}: the CPU time of all runs is less than 1 % of the time (${fixed(runTime / 100)} s)`);
    // Spec 7.4, check 4: a failed run passes when it has a known cause (for example,
    // the network was down). That needs a person: the line says REVIEW, and it does
    // not change the exit status.
    if (bad.length === 0)
        print(`PASS: ${role.name}: every run exits 0`);
    else
        print(`REVIEW: ${role.name}: ${bad.length} runs did not succeed (listed above); each needs a known cause ` +
            '(see journal.txt at the same time)');
}

// Spec 7.4, check 5, for one updater role against the control: the raw and the
// post-GC trends of PSS and of its anonymous part, and the CPU time.
function shellChecks(updater, control, span) {
    const added = (key) => updater[key].slope - control[key].slope;
    const limit = control.meanPss / 100;
    print(`added by ${updater.name} (over ${hms(span)} after the warm-up; the limit is 1 % of the control PSS, ${fixed(limit)} KB):`);
    const rules = [
        ['pss', 'raw PSS'], ['anon', 'raw anonymous PSS'],
        ['gcPss', 'post-GC PSS'], ['gcAnon', 'post-GC anonymous PSS'],
    ];
    for (const [key, label] of rules) {
        const trend = added(key);
        const growth = trend * hours(span);
        print(`  ${label}: trend ${fixed(trend)} KB/h, growth ${fixed(growth)} KB`);
        verdict(Number.isFinite(growth) && growth < limit,
            `${updater.name}: gnome-shell ${label}: no trend that the control does not have (added growth ${fixed(growth)} KB)`);
    }
    const addedCpu = (updater.cpu / updater.seconds - control.cpu / control.seconds) * 100;
    const addedGroupCpu = (updater.groupCpu / updater.seconds - control.groupCpu / control.seconds) * 100;
    print(`  CPU: ${fixed(addedCpu, 3)} % of one core (with the children of the shell: ${fixed(addedGroupCpu, 3)} %)`);
    verdict(addedCpu < 1, `${updater.name}: gnome-shell: the updater adds less than 1 % of one core`);
}

function soak(dir, expect) {
    if (!isDir(file(dir, 'control'))) throw new Error(`${dir}: no control folder`);
    const roleNames = ['updater', 'updater-unchanged'].filter(name => isDir(file(dir, name)));
    if (roleNames.length === 0) throw new Error(`${dir}: no updater folder`);
    const roles = [...roleNames, 'control'].map(name => loadRole(file(dir, name), name));
    // PSS divides shared pages between all processes that map them, also across the
    // containers. When one container stops, the PSS of the others jumps. The shell
    // trends use only the samples up to 30 s before the earliest last sample.
    const lastElapsed = r => (r.all.length ? r.all[r.all.length - 1].elapsed_s : 0);
    const cut = Math.min(...roles.map(lastElapsed)) - 30;
    for (const role of roles) {
        role.cut = cut;
        role.samples = role.all.filter(s => s.elapsed_s <= cut);
    }
    const duration = Math.max(0, cut);
    // gnome-shell grows after its start; the trend counts after the first hour, or
    // after the first 10 % of a run that is shorter than 10 hours.
    const warmup = Math.min(3600, duration / 10);
    print(`soak: ${dir}; ${hms(duration)} of shell samples used (${duration} s); roles: ${roles.map(r => r.name).join(', ')}` +
        (expect !== null ? `; expected ${expect} s` : ''));
    print('');
    print('data:');
    const aborted = file(dir, 'aborted');
    if (GLib.file_test(aborted, GLib.FileTest.EXISTS))
        print(`  aborted: ${readText(aborted).trim()}`);
    verdict(!GLib.file_test(aborted, GLib.FileTest.EXISTS), 'data: soak.sh ran to the end (no aborted file)');
    for (const role of roles) dataChecks(role, expect);
    print('');
    for (const role of roles.filter(r => r.name !== 'control')) {
        runChecks(role);
        print('');
    }
    print('gnome-shell (spec 7.4, check 5):');
    const shells = Object.fromEntries(roles.map(r => [r.name, shellSummary(r, warmup)]));
    const control = shells.control;
    for (const name of roleNames) {
        verdict(shells[name].restarts === 0 && control.restarts === 0 &&
            shells[name].alive === shells[name].samples && control.alive === control.samples,
        `${name}: gnome-shell runs in this container and in the control for the whole soak`);
        verdict(shells[name].gcProbes >= 1 && shells[name].gcCollected === shells[name].gcProbes &&
            control.gcProbes >= 1 && control.gcCollected === control.gcProbes,
        `${name}: every GC probe ran, in this container and in the control ` +
            `(${shells[name].gcCollected}/${shells[name].gcProbes}, control ${control.gcCollected}/${control.gcProbes})`);
        shellChecks(shells[name], control, duration - warmup);
    }
}

const args = ARGV.slice();
try {
    if (args[0] === '--soak') {
        args.shift();
        let expect = null;
        if (args[0] === '--expect') {
            expect = Number(args[1]);
            if (!(expect > 0)) usage();
            args.splice(0, 2);
        }
        if (args.length !== 1) usage();
        soak(args[0], expect);
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
