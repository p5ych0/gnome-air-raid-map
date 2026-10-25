// SPDX-License-Identifier: MIT
// The watcher of tests/leak/soak.sh. A copy of soak.sh runs in a temporary tree with a
// fake run-systemd.sh, a fake podman and a fake gdb, so no container starts and gdb
// attaches to nothing. The name of a fake container is its output folder; the container
// stops when the file "stopped" is there.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {test, run, assertEqual, assertTrue} from '../lib/assert.js';
import {removeTree} from '../lib/files.js';

const SOAK = GLib.filename_from_uri(
    GLib.Uri.resolve_relative(import.meta.url, '../leak/soak.sh', GLib.UriFlags.NONE))[0];
// The outer time limit of one soak.sh run. A run of these tests ends in a few seconds.
const LIMIT_S = 20;

const PODMAN = `#!/bin/bash
case $1 in
    ps | rm) ;;
    build) cat > /dev/null ;;
    container) [ "$2" = exists ] && [ -d "$3" ] ;;
    # The PID of the first process of a container: the fake gnome-shell of its sampler.
    inspect) if [ "$3" = '{{.State.Pid}}' ]; then cat "\${!#}/init-pid"
        elif [ -e "\${!#}/stopped" ]; then echo false; else echo true; fi ;;
    unshare) shift; exec "$@" ;;
    *) echo "fake podman: $*" >&2; exit 1 ;;
esac
`;

// Like the real run-systemd.sh: the sampler runs before the container name is written.
const RUN_SYSTEMD = `#!/bin/bash
here=$(cd "$(dirname "$0")" && pwd)
out=$here/out/$GNOME_TEST_OUT_NAME
mkdir -p "$out"
bash "$here/sampler-$GNOME_TEST_SOAK_ROLE.sh" "$out"
echo "$out" > "$out/container"
`;

// Writes its arguments to gdb-args in the folder of the soak.sh copy, and prints what
// gdb 17 prints for the trim.
const GDB = `#!/bin/bash
printf '%s\\n' "$@" > "$(dirname "$0")/../gdb-args"
echo '$1 = 1'
echo '[Inferior 1 (process 4242) detached]'
`;

const HEADER = ['epoch', 'elapsed_s', 'shell_pid', 'shell_pss_kb', 'shell_pss_anon_kb', 'shell_pss_shmem_kb',
    'shell_rss_kb', 'shell_cpu_s', 'group_pss_kb', 'group_mem_bytes', 'group_cpu_us', 'journal_lines',
    'shell_journal_lines', 'metadata_write_bytes'].join('\t');

// The fake sampler of one role writes one sample that is age seconds old. ended: it wrote
// "sampler end" at once. stopAfter: the sampler ends and the container stops after that
// many seconds (null: the container runs until soak.sh stops). trim: it asks for a
// malloc_trim(0) in gnome-shell (request 17), as soak-sampler.sh does. The fake container
// has no PID namespace of its own: its "gnome-shell" is a sleep process on the host, so
// its container PID is its host PID. pids: the host PID of the container init and the
// container PID of gnome-shell in the request, for a fake proc folder.
function sampler({age, ended = false, stopAfter = null, trim = false, pids = null}) {
    return `#!/bin/bash
out=$1
${trim ? `sleep 10 < /dev/null > /dev/null 2>&1 &
shell=$!
echo "${pids ? pids.init : '$shell'}" > "$out/init-pid"
printf '17\\t%s\\n' "${pids ? pids.shell : '$shell'}" > "$out/trim-request"` : ''}
printf '# %s\\n' '${HEADER}' > "$out/samples.tsv"
printf '%s\\t0\\t4242\\t1000\\t500\\t10\\t2000\\t1.00\\t1500\\t3000000\\t1000000\\t0\\t0\\t\\n' \\
    $(($(date +%s) - ${age})) >> "$out/samples.tsv"
echo "sampler start" > "$out/sampler.log"
${ended ? 'echo "sampler end" >> "$out/sampler.log"' : ''}
${stopAfter === null ? '' : `(sleep ${stopAfter}; echo "sampler end" >> "$out/sampler.log"; touch "$out/stopped"
    ${trim ? 'kill "$shell"' : ''}) > /dev/null 2>&1 &`}
`;
}

function write(path, text, mode = 0o644) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, text);
    Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', mode, Gio.FileQueryInfoFlags.NONE, null);
}

// Runs a copy of soak.sh for 5 s with a watcher poll of 1 s. roles: the sampler of each
// role. env: more environment variables. Returns the exit status, the lines of soak.log,
// the trim-result file of each role that has one, and the arguments of the fake gdb.
function soakWith(roles, env = {}) {
    const dir = GLib.dir_make_tmp('air-raid-soak-XXXXXX');
    try {
        write(`${dir}/tests/leak/soak.sh`, GLib.file_get_contents(SOAK)[1]);
        write(`${dir}/tests/gnome/Containerfile.fedora44-systemd`, '');
        write(`${dir}/tests/gnome/run-systemd.sh`, RUN_SYSTEMD, 0o755);
        for (const [role, options] of Object.entries(roles))
            write(`${dir}/tests/gnome/sampler-${role}.sh`, sampler(options));
        write(`${dir}/bin/podman`, PODMAN, 0o755);
        write(`${dir}/bin/gdb`, GDB, 0o755);
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        launcher.setenv('PATH', `${dir}/bin:${GLib.getenv('PATH')}`, true);
        launcher.setenv('GNOME_TEST_SOAK_POLL', '1', true);
        for (const [name, value] of Object.entries(env))
            launcher.setenv(name, value.replace('@', dir), true);
        const process = launcher.spawnv(['timeout', `${LIMIT_S}`, 'bash', `${dir}/tests/leak/soak.sh`, '5']);
        const [, output] = process.communicate_utf8(null, null);
        const log = `${dir}/tests/gnome/out/soak-latest/soak.log`;
        const read = path => (GLib.file_test(path, GLib.FileTest.EXISTS)
            ? new TextDecoder().decode(GLib.file_get_contents(path)[1]) : null);
        const lines = (read(log) ?? '').split('\n').filter(line => line);
        const results = Object.fromEntries(Object.keys(roles)
            .map(role => [role, read(`${dir}/tests/gnome/out/soak-latest/${role}/trim-result`)])
            .filter(([, text]) => text !== null));
        const gdbArgs = read(`${dir}/gdb-args`);
        const shellPid = (read(`${dir}/tests/gnome/out/soak-latest/updater/init-pid`) ?? '').trim();
        return {status: process.get_exit_status(), output, lines, results, gdbArgs, shellPid};
    } finally {
        removeTree(dir);
    }
}

const fails = lines => lines.filter(line => / FAIL: /.test(line));

test('the watcher reports a sampler that stopped', () => {
    const {status, output, lines} = soakWith({
        updater: {age: 0}, 'updater-unchanged': {age: 0}, control: {age: 200},
    });
    const stopped = lines.filter(line => / FAIL: control: the sampler stopped \(the last sample is \d+ s old/.test(line));
    assertEqual(stopped.length, 1, `FAIL lines for the control sampler in:\n${output}`);
    assertTrue(!lines.some(line => / FAIL: updater(-unchanged)?: the sampler stopped/.test(line)),
        `a FAIL line for a sampler that runs:\n${output}`);
    assertEqual(status, 1, 'exit status');
});

test('the watcher accepts a new sample, and an old sample after the sampler ended', () => {
    const {status, output, lines} = soakWith({
        updater: {age: 0, stopAfter: 3}, 'updater-unchanged': {age: 200, ended: true, stopAfter: 3},
        control: {age: 0, stopAfter: 3},
    });
    assertEqual(fails(lines).length, 0, `FAIL lines:\n${output}`);
    assertTrue(lines.some(line => / done; evaluate with: /.test(line)), `no done line:\n${output}`);
    assertEqual(status, 0, 'exit status');
});

// The sampler runs in the container, and the image has no gdb. So soak.sh answers the trim
// requests with the gdb of the host: it attaches to the host PID of gnome-shell, uses the
// libraries of the container (sysroot), calls malloc_trim(0) and detaches.
test('the watcher calls malloc_trim(0) in gnome-shell for the trim request of a sampler', () => {
    const {status, output, lines, results, gdbArgs, shellPid} = soakWith({
        updater: {age: 0, stopAfter: 3, trim: true}, 'updater-unchanged': {age: 0, stopAfter: 3},
        control: {age: 0, stopAfter: 3},
    }, {GNOME_TEST_SOAK_GDB: '@/bin/gdb'});
    assertEqual(results.updater, '17\tok\tmalloc_trim returned 1\n', `trim-result of the updater; soak.log:\n${output}`);
    assertEqual(Object.keys(results).length, 1, 'trim-result files');
    const args = (gdbArgs ?? '').split('\n');
    assertTrue(/^[0-9]+$/.test(shellPid), `the PID of the fake gnome-shell: ${shellPid}`);
    for (const arg of ['-batch', '-p', shellPid, `set sysroot /proc/${shellPid}/root`, 'call (int) malloc_trim(0)', 'detach'])
        assertTrue(args.includes(arg), `gdb argument "${arg}" in:\n${gdbArgs}`);
    assertTrue(lines.some(line => / updater: malloc_trim\(0\) in gnome-shell: ok: malloc_trim returned 1$/.test(line)),
        `the trim line in soak.log:\n${lines.join('\n')}`);
    assertEqual(status, 0, 'exit status');
});

// host_pid reads the NSpid line of each status file of the proc folder. A process can exit
// after the glob and before gawk opens its status file. The fake proc folder has such a
// file (1/status, a link to nothing) before the status file of gnome-shell. gnome-shell
// has the container PID 55 and the host PID 8888, in the PID namespace of the container
// init (host PID 700).
test('the host PID scan skips a status file that is gone, and finds gnome-shell', () => {
    const proc = GLib.dir_make_tmp('air-raid-proc-XXXXXX');
    const link = (path, target) => {
        GLib.mkdir_with_parents(GLib.path_get_dirname(`${proc}/${path}`), 0o700);
        Gio.File.new_for_path(`${proc}/${path}`).make_symbolic_link(target, null);
    };
    try {
        link('1/status', 'gone');
        link('700/ns/pid', 'pid:[4026532001]');
        link('8888/ns/pid', 'pid:[4026532001]');
        GLib.file_set_contents(`${proc}/8888/status`, 'Name:\tgnome-shell\nNSpid:\t8888\t55\n');
        const {results, gdbArgs} = soakWith({
            updater: {age: 0, stopAfter: 3, trim: true, pids: {init: 700, shell: 55}},
            'updater-unchanged': {age: 0, stopAfter: 3}, control: {age: 0, stopAfter: 3},
        }, {GNOME_TEST_SOAK_GDB: '@/bin/gdb', GNOME_TEST_SOAK_PROC: proc});
        assertEqual(results.updater, '17\tok\tmalloc_trim returned 1\n', 'trim-result of the updater');
        const args = (gdbArgs ?? '').split('\n');
        assertEqual(args[args.indexOf('-p') + 1], '8888', `the PID of gdb in:\n${gdbArgs}`);
    } finally {
        removeTree(proc);
    }
});

test('a trim request fails with the reason when gdb is not installed on the host', () => {
    const {results, gdbArgs} = soakWith({
        updater: {age: 0, stopAfter: 3, trim: true}, 'updater-unchanged': {age: 0, stopAfter: 3},
        control: {age: 0, stopAfter: 3},
    }, {GNOME_TEST_SOAK_GDB: 'gdb-not-installed'});
    assertEqual(results.updater, '17\tfail\tgdb-not-installed is not installed on the host\n', 'trim-result');
    assertEqual(gdbArgs, null, 'a gdb ran');
});

// The GC probe of tests/gnome/soak-sampler.sh. The sampler runs on the host in a temporary
// folder with a fake id, getent, runuser, systemctl, gdbus, journalctl and sleep, so it
// needs no container and no gnome-shell, and its journal cursors are in that folder. The
// fake gnome-shell is a sleep process. The fake gdbus counts its calls (6 for each try of a
// probe: 2 Evals for each of 3 collections) and, at the calls in the lists, it changes the
// InvocationID of the updater service (bump) or its ActiveState (activate, idle), as a run
// of the updater does, or it stops the fake gnome-shell service (restart: MainPID 0). The
// fake systemctl gives the LoadState "loaded" for the updater service when it exists, and
// "not-found" in the control container. With EMPTY_ID, its first read with LoadState (the
// start read of the first try) gives no InvocationID, as a read that failed. The fake
// sleep takes 10 ms, and it answers the trim request of the sampler with TRIM_RESULT, as
// tests/leak/soak.sh does.
const SAMPLER = GLib.filename_from_uri(
    GLib.Uri.resolve_relative(import.meta.url, '../gnome/soak-sampler.sh', GLib.UriFlags.NONE))[0];
const REAL_SLEEP = GLib.find_program_in_path('sleep');
const FAKES = {
    id: 'echo 1000',
    getent: 'echo tester:x:1000:1000::/home/tester:/bin/bash',
    journalctl: 'exit 0',
    // runuser -u tester -- env -i VAR=value ... command args: runs the command.
    runuser: 'shift 5; while [[ $1 == *=* ]]; do shift; done; exec "$@"',
    sleep: `id=$(cut -f1 "$OUT/trim-request" 2> /dev/null) && printf '%s\\t%s\\n' "$id" "$TRIM_RESULT" > "$OUT/trim-result"
        exec ${REAL_SLEEP} 0.01`,
    // systemctl poweroff --no-block, or systemctl --user show <options> <unit>.
    systemctl: `[ "$1" != poweroff ] || exit 0
        shift 2
        props=() value=0 unit=
        while [ $# -gt 0 ]; do
            case $1 in
                --timestamp=*) ;;
                --value) value=1 ;;
                -p) props+=("$2"); shift ;;
                -p*) props+=("\${1#-p}") ;;
                *) unit=$1 ;;
            esac
            shift
        done
        for prop in "\${props[@]}"; do
            case $unit:$prop in
                gnome-test-shell.service:MainPID) v=$(cat "$STATE/pid" 2> /dev/null || echo "$FAKE_SHELL_PID") ;;
                gnome-air-raid-map.service:InvocationID) v=$(cat "$STATE/id" 2> /dev/null)
                    if [ -n "$EMPTY_ID" ] && [[ " \${props[*]} " == *" LoadState "* ]] &&
                        mkdir "$STATE/empty-id" 2> /dev/null; then v=; fi ;;
                gnome-air-raid-map.service:ActiveState) v=$(cat "$STATE/active" 2> /dev/null) ;;
                gnome-air-raid-map.service:LoadState) if [ -e "$STATE/id" ]; then v=loaded; else v=not-found; fi ;;
                *) v= ;;
            esac
            if [ $value = 1 ]; then printf '%s\\n' "$v"; else printf '%s=%s\\n' "$prop" "$v"; fi
        done`,
    gdbus: `n=$(($(cat "$STATE/calls" 2> /dev/null || echo 0) + 1))
        echo $n > "$STATE/calls"
        for c in $BUMP; do [ "$c" != $n ] || echo "bump-$n" > "$STATE/id"; done
        for c in $ACTIVATE; do [ "$c" != $n ] || echo activating > "$STATE/active"; done
        for c in $IDLE; do [ "$c" != $n ] || echo inactive > "$STATE/active"; done
        for c in $RESTART; do [ "$c" != $n ] || echo 0 > "$STATE/pid"; done
        echo "(true, 'true')"`,
};

// Runs one GC probe of the sampler. updater: the updater service exists (the control
// container has none). bump, activate, idle, restart: the calls of the fake gdbus that
// change the services. emptyId: the first start read gives no InvocationID. trim: the
// answer to the trim request. Returns the lines of gc.tsv (without the header), the number
// of gdbus calls and the lines of sampler.log.
function probeWith({updater = true, bump = [], activate = [], idle = [], restart = [], emptyId = false,
    trim = 'ok\tmalloc_trim returned 1'} = {}) {
    const dir = GLib.dir_make_tmp('air-raid-sampler-XXXXXX');
    const shell = new Gio.Subprocess({argv: [REAL_SLEEP, '60'], flags: Gio.SubprocessFlags.NONE});
    shell.init(null);
    try {
        GLib.mkdir_with_parents(`${dir}/state`, 0o700);
        GLib.mkdir_with_parents(`${dir}/out`, 0o700);
        GLib.mkdir_with_parents(`${dir}/cursors`, 0o700);
        if (updater) {
            GLib.file_set_contents(`${dir}/state/id`, 'start\n');
            GLib.file_set_contents(`${dir}/state/active`, 'inactive\n');
        }
        for (const [name, body] of Object.entries(FAKES))
            write(`${dir}/bin/${name}`, `#!/bin/bash\n${body}\n`, 0o755);
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        const env = {
            PATH: `${dir}/bin:${GLib.getenv('PATH')}`, OUT: `${dir}/out`, STATE: `${dir}/state`,
            FAKE_SHELL_PID: shell.get_identifier(), BUMP: bump.join(' '), ACTIVATE: activate.join(' '),
            IDLE: idle.join(' '), RESTART: restart.join(' '), EMPTY_ID: emptyId ? '1' : '', TRIM_RESULT: trim,
            GNOME_TEST_SOAK_OUT: `${dir}/out`,
            GNOME_TEST_SOAK_CURSOR_DIR: `${dir}/cursors`, GNOME_TEST_SOAK_POWEROFF: '0',
            // The probe starts 2 s after the sampler and may end after it: no margin.
            GNOME_TEST_SOAK_GC_INTERVAL: '2', GNOME_TEST_SOAK_PROBE_MARGIN: '0',
        };
        for (const [name, value] of Object.entries(env)) launcher.setenv(name, value, true);
        const process = launcher.spawnv(['timeout', '60', 'bash', SAMPLER, '3']);
        const [, output] = process.communicate_utf8(null, null);
        const read = path => (GLib.file_test(path, GLib.FileTest.EXISTS)
            ? new TextDecoder().decode(GLib.file_get_contents(path)[1]) : '');
        const lines = path => read(path).split('\n').filter(line => line);
        return {
            output, status: process.get_exit_status(),
            gc: lines(`${dir}/out/gc.tsv`).filter(line => !line.startsWith('#')).map(line => line.split('\t')),
            calls: Number(read(`${dir}/state/calls`) || 0),
            log: lines(`${dir}/out/sampler.log`),
        };
    } finally {
        shell.force_exit();
        removeTree(dir);
    }
}
// The columns of gc.tsv: 3 is "collected", 4 is gc_passes, 5 is trim.
const overlaps = log => log.filter(line => / an updater run overlapped it; the sample is discarded$/.test(line));

test('a probe without an updater run in it makes one try and one line', () => {
    const {output, gc, calls, log} = probeWith();
    assertEqual(gc.length, 1, `lines of gc.tsv; output:\n${output}`);
    assertEqual(gc[0].slice(3, 6).join(' '), 'true,true,true 3 ok', 'collected, passes, trim');
    assertEqual(calls, 6, 'Evals');
    assertEqual(overlaps(log).length, 0, `sampler.log:\n${log.join('\n')}`);
});

test('a new InvocationID during the probe discards the sample, and the second try is the sample', () => {
    const {output, gc, calls, log} = probeWith({bump: [3]});
    assertEqual(gc.length, 1, `lines of gc.tsv; output:\n${output}`);
    assertEqual(gc[0].slice(3, 6).join(' '), 'true,true,true 3 ok', 'collected, passes, trim');
    assertEqual(calls, 12, 'Evals: two tries');
    assertEqual(overlaps(log).length, 1, `sampler.log:\n${log.join('\n')}`);
    assertTrue(overlaps(log)[0].includes('try 1 of 3'), `the try in:\n${log.join('\n')}`);
});

test('an updater run that is active at the end or at the start of a try discards the sample', () => {
    // The run is active from the 3rd Eval and ends at the first Eval of the second try. So
    // the run is active at the end of try 1 and at the start of try 2, and try 3 is the sample.
    const {output, gc, calls, log} = probeWith({activate: [3], idle: [7]});
    assertEqual(gc.length, 1, `lines of gc.tsv; output:\n${output}`);
    assertEqual(gc[0][3], 'true,true,true', 'collected');
    assertEqual(calls, 18, 'Evals: three tries');
    assertEqual(overlaps(log).length, 2, `sampler.log:\n${log.join('\n')}`);
});

test('three overlaps give a line with "updater overlap" in place of the collections', () => {
    const {output, gc, calls, log} = probeWith({bump: [3, 9, 15]});
    assertEqual(gc.length, 1, `lines of gc.tsv; output:\n${output}`);
    assertEqual(gc[0][3], 'updater overlap', 'collected');
    assertEqual(calls, 18, 'Evals: three tries');
    assertEqual(overlaps(log).length, 3, `sampler.log:\n${log.join('\n')}`);
});

test('a shell restart and three overlaps give both reasons in "collected"', () => {
    // The fake gnome-shell service stops in the last try.
    const {output, gc, calls} = probeWith({bump: [3, 9, 15], restart: [16]});
    assertEqual(gc.length, 1, `lines of gc.tsv; output:\n${output}`);
    assertEqual(gc[0][3], 'shell restarted,updater overlap', 'collected');
    assertEqual(calls, 18, 'Evals: three tries');
});

test('a start read with no InvocationID for a loaded updater service discards the sample', () => {
    const {output, gc, calls, log} = probeWith({emptyId: true});
    assertEqual(gc.length, 1, `lines of gc.tsv; output:\n${output}`);
    assertEqual(gc[0][3], 'true,true,true', 'collected');
    assertEqual(calls, 12, 'Evals: two tries');
    assertEqual(overlaps(log).length, 1, `sampler.log:\n${log.join('\n')}`);
    assertTrue(overlaps(log)[0].includes('try 1 of 3'), `the try in:\n${log.join('\n')}`);
});

// A failed trim fails the probe anyway. Another try would only hide the reason.
test('a try with a failed trim is the result, also when an updater run overlapped it', () => {
    const {output, gc, calls, log} = probeWith({bump: [3], trim: 'fail\tgdb is not installed on the host'});
    assertEqual(gc.length, 1, `lines of gc.tsv; output:\n${output}`);
    assertEqual(gc[0].slice(3, 7).join(' | '), 'true,true,true | 3 | fail | gdb is not installed on the host',
        'collected, passes, trim, trim_detail');
    assertEqual(calls, 6, 'Evals: one try');
    assertEqual(overlaps(log).length, 0, `sampler.log:\n${log.join('\n')}`);
});

test('the control container, with no updater service, makes one try', () => {
    const {output, gc, calls, log} = probeWith({updater: false, bump: [3]});
    assertEqual(gc.length, 1, `lines of gc.tsv; output:\n${output}`);
    assertEqual(gc[0][3], 'true,true,true', 'collected');
    assertEqual(calls, 6, 'Evals');
    assertEqual(overlaps(log).length, 0, `sampler.log:\n${log.join('\n')}`);
});

await run();
