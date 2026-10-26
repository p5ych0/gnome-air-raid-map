// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {test, run, assertEqual, assertTrue} from '../lib/assert.js';
import {removeTree} from '../lib/files.js';
import {CHECKS, family} from '../../updater/deps.js';

// The file that each check loads. The package that check-deps.js names for a
// missing item must be the package that has this file (#9).
const TYPELIBS = ['/usr/lib64/girepository-1.0', '/usr/lib/x86_64-linux-gnu/girepository-1.0',
    '/usr/lib/aarch64-linux-gnu/girepository-1.0', '/usr/lib/girepository-1.0'];
const FILES = {
    'Soup 3.0': 'Soup-3.0.typelib',
    'Pango': 'Pango-1.0.typelib',
    'PangoCairo': 'PangoCairo-1.0.typelib',
    'cairo': 'cairo-1.0.typelib',
    'the settings schema org.gnome.desktop.background': '/usr/share/glib-2.0/schemas/org.gnome.desktop.background.gschema.xml',
};

function findFile(name) {
    const paths = name.startsWith('/') ? [name] : TYPELIBS.map(dir => `${dir}/${name}`);
    return paths.find(path => GLib.file_test(path, GLib.FileTest.EXISTS)) ?? null;
}

const output = argv => {
    const [, stdout, , status] = GLib.spawn_sync(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
    return status === 0 ? new TextDecoder().decode(stdout) : null;
};

// The package that owns path in the package database of the family (0: rpm,
// 1: dpkg), or null.
function owner(path, index) {
    if (index === 0 && GLib.find_program_in_path('rpm')) {
        const text = output(['rpm', '-qf', '--qf', '%{NAME}\n', path]);
        if (text) return text.split('\n')[0];
    }
    if (index === 1 && GLib.find_program_in_path('dpkg')) {
        // dpkg -S prints "<package>[:<arch>][, <package>]: <path>".
        const text = output(['dpkg', '-S', path]);
        if (text) return text.split(':')[0].split(',')[0];
    }
    return null;
}

test('each check has a known file', () =>
    assertEqual(CHECKS.map(check => check.name).join(' | '), Object.keys(FILES).join(' | ')));

// check-deps.js names the packages of the family of the system. Another rpm or dpkg
// distribution can name its packages in another way, so the test compares only the
// two known families.
test('each named package has the file of its check', () => {
    const index = family();
    if (index < 0) {
        print('# skip: the distribution family is not Fedora or Debian');
        return;
    }
    let checked = 0;
    for (const {name, packages} of CHECKS) {
        const path = findFile(FILES[name]);
        const pkg = path && owner(path, index);
        if (!pkg) {
            print(`# skip: no package database knows the file of ${name}`);
            continue;
        }
        assertEqual(packages[index], pkg, `${name} (${path})`);
        ++checked;
    }
    assertTrue(checked > 0 || (!GLib.find_program_in_path('rpm') && !GLib.find_program_in_path('dpkg')),
        'no check was compared with the package database');
});

test('the family comes from ID and ID_LIKE of os-release', () => {
    const dir = GLib.dir_make_tmp('air-raid-deps-XXXXXX');
    try {
        const familyOf = text => {
            GLib.file_set_contents(`${dir}/os-release`, text);
            return family(`${dir}/os-release`);
        };
        assertEqual(familyOf('ID=fedora\n'), 0);
        assertEqual(familyOf('ID="rocky"\nID_LIKE="rhel centos fedora"\n'), 0);
        assertEqual(familyOf('ID=ubuntu\nID_LIKE=debian\n'), 1);
        assertEqual(familyOf('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n'), -1);
        assertEqual(family(`${dir}/missing`), -1);
    } finally {
        removeTree(dir);
    }
});

const CHECK_DEPS = GLib.filename_from_uri(
    GLib.Uri.resolve_relative(import.meta.url, '../../updater/check-deps.js', GLib.UriFlags.NONE))[0];

// The script runs its check under any file name. The copy finds the table next to it:
// here a table with one typelib that no package has, so the import fails as for a
// missing package.
test('a copy under another name checks and reports a missing typelib', () => {
    const dir = GLib.dir_make_tmp('air-raid-deps-XXXXXX');
    try {
        GLib.file_set_contents(`${dir}/verify-packages.js`, GLib.file_get_contents(CHECK_DEPS)[1]);
        GLib.file_set_contents(`${dir}/deps.js`, `export const CHECKS = [{name: 'AirRaidMissing 1.0',
            packages: ['air-raid-missing', 'air-raid-missing'], load: () => import('gi://AirRaidMissing')}];
            export const family = () => -1;\n`);
        const process = Gio.Subprocess.new(['gjs', '-m', `${dir}/verify-packages.js`],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const [, stdout, stderr] = process.communicate_utf8(null, null);
        assertEqual(stderr, 'gnome-air-raid-map: missing AirRaidMissing 1.0: install the package air-raid-missing\n');
        assertEqual(stdout, '');
        assertEqual(process.get_exit_status(), 1);
    } finally {
        removeTree(dir);
    }
});

await run();
