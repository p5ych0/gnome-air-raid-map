# Decision: picture reload method

Date: 2026-10-23. Plan Task 7. Spec section 5.6, "Risk: picture reload".

## Decision

The updater writes the picture with **rename** (method `rename`): it writes
`<name>.tmp` in `$XDG_RUNTIME_DIR/gnome-air-raid-map/` and renames it over
the live picture `<name>`. It sets the wallpaper settings only when they do
not point to the live picture, and then the live picture gets a new name
(see "Recovery after the failure banner"). `updater/writer.js` exports
`DEFAULT_RELOAD_METHOD = 'rename'`.

Reason:

- `in-place` and `rename` both passed 100 of 100 updates on both images.
  Both showed each new picture at the first sample (250 ms), and dconf
  wrote nothing during updates with either method (see "Results").
- A write that stops halfway shows an incomplete picture with `in-place`:
  GNOME 50 shows no picture (only the default background color), and
  GNOME 46 shows half a picture (see "Incomplete write"). A run can stop
  during a write in normal use: the service has `MemoryMax=300M` and
  `TimeoutStartSec=25s`.
- Spec 5.6 requires: "No black or empty frame appears between pictures."
  `in-place` can show such a frame. `rename` cannot: an incomplete file is
  only the temporary file, and the Shell continues to show the last
  complete picture.
- The plan said to use the first method that passes, in the order
  `in-place`, `rename`, `alternate`. That order would choose `in-place`.
  The controller ruled that the spec criterion has priority over the order
  of the plan, so `rename` is the chosen method.

## Results

Command: `tests/gnome/run.sh fedora44 reload && tests/gnome/run.sh ubuntu2404 reload`
(one virtual monitor, 1920×1080). Fedora 44: GNOME Shell 50.6, GJS 1.88.1.
Ubuntu 24.04: GNOME Shell 46.0, GJS 1.80.2.

| Method | Fedora 44: passed | Fedora 44: color rule alone | Ubuntu 24.04: passed | Ubuntu 24.04: color rule alone |
|---|---|---|---|---|
| `in-place` | **100/100** | 100/100 | **100/100** | 100/100 |
| `rename` | **100/100** | 100/100 | **100/100** | 100/100 |
| `alternate` | 25/100 | 100/100 | 25/100 | 100/100 |

"Color rule alone" is the rule of the plan. "Passed" also needs the marker
rule (see "Test").

On both images, for each method, the first sample (250 ms after the write)
showed the new color in every update. No center sample was black or another
color. The latest first sample was 321 ms after the write, because the
screenshot started late under load.

An earlier run of the same scenario, before two harness changes (the Ubuntu
dock on the left, no notification banners), gave the same counts on both
images.

## Test

`tests/gnome/scenarios/reload.sh` runs `reload.js` for each method. Each
method starts with its own start picture and sets the wallpaper to it
(`picture-options` `spanned`). Then it does 100 updates. One update:

1. Wait until the screen shows the previous picture (5 s at most).
2. Write a new picture with `writePicture` of `updater/writer.js`. The
   picture is solid `#cc1a1a` (odd updates) or `#1a1acc` (even updates).
   Method `alternate` also sets `picture-uri` and `picture-uri-dark` to the
   returned path.
3. Take a screenshot every 250 ms for 2 s (8 samples), with
   `org.gnome.Shell.Screenshot`.
4. Sample the center of the primary monitor.

Color rule (plan): before the write, the screen showed the old color. The
new color appears within 2 s and stays. No sample is black or another color.

Marker rule (added in this task): each picture also has a 64×64 square at
3/4 of the monitor width and height, in one of four colors (update number
modulo 4). Before the write, the screen shows the marker of the previous
picture. When the center shows the new color, the marker must be the new
marker. The reason: with two colors and two files in turn, method
`alternate` always writes red to one file and blue to the other. A screen
that shows an old copy of a file then has the correct color. Only the marker
shows that the copy is old.

`tests/gnome/out/<image>-reload/reload-<method>.tsv` has every sample of
every update. The folder also has a screenshot of update 1 and all samples of
the first three failed updates.

## Why each method passes or fails

The Shell (`ui/background.js`; this code is the same in GNOME 46 and 50)
watches the picture file with a `Gio.FileMonitor`. On each event other than
`CHANGED` and `CREATED`, it removes the file from `Meta.BackgroundImageCache`
and loads the picture again.

- `in-place`: Cairo truncates the file, writes it, and closes it. GLib sends
  `CHANGED` events and then `CHANGES_DONE_HINT` after the close. The Shell
  loads the complete file.
- `rename`: GLib sends `DELETED`, `CREATED`, and `CHANGES_DONE_HINT` for a
  file that is renamed over the watched file (checked with GLib 2.88). The
  Shell loads the new file. The spec guessed that a rename "probably does
  not send that event". That guess is wrong.
- `alternate`: when `picture-uri` changes to file B, the Shell destroys the
  background object of file A. That object was the only one that removed
  file A from the image cache on a file event. The next update writes file A
  again, but the cache can still have the old copy of file A. When
  `picture-uri` changes back to file A, the Shell then shows the old copy
  (the picture of two updates before). The results repeat every four
  updates: one update passes, two updates show an old copy, and the next
  update starts from the wrong picture. We did not find why the Shell loads
  the new file in one update of four. The color rule alone does not find
  this failure (see "Test").

## Recovery after the failure banner

Checked on 2026-10-24. While the banner shows, the Shell does not watch the
live picture file. So when the next good run puts the live picture back under
the same name, the Shell can show a cached copy of the old picture, as with
`alternate`. Step 6 of `tests/gnome/scenarios/install.sh` checks this: before
the recovery run, it removes the red alert from the fixture data, so the
recovered picture is different. After the recovery, the screenshot must show
the new color `#223448` in the synthetic square on each monitor, not the red
`#cf4655` of the old picture.

With the same name (`picture.png`), the check failed once in 17 runs on
Fedora 44 (1920×1080 and 1080×1920 in one session): both monitors showed the
old picture with the red alert after the recovery. It passed in 1 run on
Fedora 44 with 1080×1920 alone and in 9 runs on Ubuntu 24.04 (1920×1080).
The old picture, not the banner, was on the screen, so the Shell loaded its
cached copy of `picture.png`.

Decision: when the wallpaper settings do not point to the live picture (after
the banner, at the first run, or after a change by the user), the updater
writes the live picture under a new name, `picture-<unix-ms>.png` in the same
folder, points the settings to it, and deletes the previous live file. The
Shell never showed the new name, so it has no cached copy of it. A normal
update, when the settings point to the live picture, keeps the name and the
`rename` method. `updater/run.js` does this; `tests/unit/test-run.js` tests
the names. After this change the check passed in 12 of 12 runs on Fedora 44
(1920×1080 and 1080×1920 in one session) and in 6 of 6 runs on Ubuntu 24.04
(1920×1080).

## dconf writes

Spec 5.6 asks for this number only if `alternate` is the only method that
passes. It is not, but the scenario measures it for each method. It counts
the bytes that `dconf-service` writes (`wchar` in `/proc/<pid>/io`) during
the 100 updates. The size of `~/.config/dconf/user` does not show the
writes: dconf writes the whole file again on each change, and the size stays
almost the same.

| Method | Fedora 44: bytes in 100 updates | Fedora 44: bytes per day | Ubuntu 24.04: bytes in 100 updates | Ubuntu 24.04: bytes per day |
|---|---|---|---|---|
| `in-place` | 0 | 0 | 0 | 0 |
| `rename` | 0 | 0 | 0 | 0 |
| `alternate` | 158,624 | 2,284,186 (2.2 MiB) | 197,000 | 2,836,800 (2.7 MiB) |

The database file had 1,531 bytes (Fedora) and 1,915 bytes (Ubuntu).

At one update per minute, the bytes per day are the bytes per 100 updates ×
14.4. The test database has only the background keys. On a real desktop the
database has all user settings and is larger. dconf writes the whole
database on each change, so method `alternate` writes more there.

## Limits of the test

- **No fade.** The headless Shell renders without a GPU. The Shell then
  turns off animations (`main.js`: `is_rendering_hardware_accelerated()`), so
  the 1-second fade from the old picture to the new one does not run. On a
  real desktop, samples during the fade show a mix of the two colors. That
  mix is not a black or empty frame. A later test can turn the fade on with
  `gnome-shell --force-animations` (GNOME 46 and 50 have this option).
- **Small pictures.** A solid PNG has a few kilobytes. A map PNG is larger
  and takes longer to write. The Shell loads the file only after
  `CHANGES_DONE_HINT`, which comes after the close, so the size does not
  change the result of the test. A process that reads the file during an
  in-place write sees an incomplete file.
- **Settings in one change.** When `picture-uri` and `picture-uri-dark`
  change in two separate writes, the Shell starts to load the picture for the
  first change and then destroys it (`this._fileWatches is null` in
  `shell.log`). The scenario writes the keys in one change
  (`Gio.Settings.delay()` and `apply()`), and the error does not occur.
  `updater/wallpaper.js` (Task 8) must do the same.

## Incomplete write

A one-time check (not a scenario in the repository) on both images, with
`writePicture` and method `in-place`:

1. Write a full picture (red, with a band of random squares: a 167 KB PNG)
   and set the wallpaper to it.
2. Write only the first half of a blue picture of the same kind over
   `picture.png` and close the file. This is what remains when the updater
   stops during a write (for example, a full `$XDG_RUNTIME_DIR`, or a kill
   at `MemoryMax`).
3. Write a full green picture in place.

| Step | GNOME 50 (Fedora 44) | GNOME 46 (Ubuntu 24.04) |
|---|---|---|
| 1 | red picture | red picture |
| 2, for 4 s | no picture: only the default background color `#023c88` | the decoded top part of the picture; gray below it |
| 3 | green picture | green picture |

In the updater, a short write makes `writePicture` throw (it checks the PNG
end chunk), and the run fails. A killed process does not throw. In both
cases the wallpaper stays wrong until the next good write: the next run, 30
seconds later, if its write succeeds. With method `rename`, an incomplete
file is only the temporary file, and the Shell continues to show the last
complete picture.

This result decided the method (see "Decision").
