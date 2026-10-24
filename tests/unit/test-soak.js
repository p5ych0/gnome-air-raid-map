// SPDX-License-Identifier: MIT
// The watcher of tests/leak/soak.sh. A copy of soak.sh runs in a temporary tree with a
// fake run-systemd.sh and a fake podman, so no container starts. The name of a fake
// container is its output folder; the container stops when the file "stopped" is there.
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
    inspect) if [ -e "\${!#}/stopped" ]; then echo false; else echo true; fi ;;
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

const HEADER = ['epoch', 'elapsed_s', 'shell_pid', 'shell_pss_kb', 'shell_pss_anon_kb', 'shell_pss_shmem_kb',
    'shell_rss_kb', 'shell_cpu_s', 'group_pss_kb', 'group_mem_bytes', 'group_cpu_us', 'journal_lines',
    'shell_journal_lines', 'metadata_write_bytes'].join('\t');

// The fake sampler of one role writes one sample that is age seconds old. ended: it wrote
// "sampler end" at once. stopAfter: the sampler ends and the container stops after that
// many seconds (null: the container runs until soak.sh stops).
function sampler({age, ended = false, stopAfter = null}) {
    return `#!/bin/bash
out=$1
printf '# %s\\n' '${HEADER}' > "$out/samples.tsv"
printf '%s\\t0\\t4242\\t1000\\t500\\t10\\t2000\\t1.00\\t1500\\t3000000\\t1000000\\t0\\t0\\t\\n' \\
    $(($(date +%s) - ${age})) >> "$out/samples.tsv"
echo "sampler start" > "$out/sampler.log"
${ended ? 'echo "sampler end" >> "$out/sampler.log"' : ''}
${stopAfter === null ? '' : `(sleep ${stopAfter}; echo "sampler end" >> "$out/sampler.log"; touch "$out/stopped") \\
    > /dev/null 2>&1 &`}
`;
}

function write(path, text, mode = 0o644) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, text);
    Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', mode, Gio.FileQueryInfoFlags.NONE, null);
}

// Runs a copy of soak.sh for 5 s with a watcher poll of 1 s. roles: the sampler of each
// role. Returns the exit status and the lines of soak.log.
function soakWith(roles) {
    const dir = GLib.dir_make_tmp('air-raid-soak-XXXXXX');
    try {
        write(`${dir}/tests/leak/soak.sh`, GLib.file_get_contents(SOAK)[1]);
        write(`${dir}/tests/gnome/Containerfile.fedora44-systemd`, '');
        write(`${dir}/tests/gnome/run-systemd.sh`, RUN_SYSTEMD, 0o755);
        for (const [role, options] of Object.entries(roles))
            write(`${dir}/tests/gnome/sampler-${role}.sh`, sampler(options));
        write(`${dir}/bin/podman`, PODMAN, 0o755);
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        launcher.setenv('PATH', `${dir}/bin:${GLib.getenv('PATH')}`, true);
        launcher.setenv('GNOME_TEST_SOAK_POLL', '1', true);
        const process = launcher.spawnv(['timeout', `${LIMIT_S}`, 'bash', `${dir}/tests/leak/soak.sh`, '5']);
        const [, output] = process.communicate_utf8(null, null);
        const log = `${dir}/tests/gnome/out/soak-latest/soak.log`;
        const lines = GLib.file_test(log, GLib.FileTest.EXISTS)
            ? new TextDecoder().decode(GLib.file_get_contents(log)[1]).split('\n') : [];
        return {status: process.get_exit_status(), output, lines};
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

await run();
