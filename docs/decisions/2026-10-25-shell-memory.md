# Decision: live memory of GNOME Shell in check 5

Date: 2026-10-25. After plan Task 11. Spec section 7.4, check 5, and
section 5.6 (the time labels). Issue
[#10](https://github.com/p5ych0/gnome-air-raid-map/issues/10) tracks the
deadlock risk.

## Decision

The owner decided on 2026-10-25:

1. **Label mode A stays the default.** Mode B does not use less memory of
   GNOME Shell (see "Why mode B looked worse").
2. **We accept the memory plateau of `gnome-shell` as allocator behavior.**
   glibc keeps the freed picture buffers inside `gnome-shell`. The level
   rises to a ceiling and then stops. It is not a leak.
3. **Check 5 judges the live memory of `gnome-shell`.** Each probe of the
   soak makes three proven garbage collections and then calls
   `malloc_trim(0)` in `gnome-shell`. The plateau rule of "The new check"
   decides.
4. **We record the plateau and the deadlock risk** in this record, in the
   spec, and in the README.
5. **The 24-hour soak runs again with the new check.**

Units in this record:

- 1 unit is 8,100 KB: one picture buffer of 1920 × 1080 × 4 bytes (RGBA).
- KB is 1,024 bytes, and MB is 1,024 KB.
- GC is a garbage collection of the GJS engine in `gnome-shell`.

## The first soak

The first 24-hour soak ran on 2026-10-24 (`tests/leak/soak.sh 86400`).

- Fedora 44 test image, one 1920×1080 monitor, software rendering.
- Three GNOME sessions at the same time: mode A (`updated`, the default),
  mode B (`unchanged`), and a control without the updater.
- The real timer ran the updater every 30 s against NEPTUN.
- The probe made one GC each hour and took one sample 30 s later.

| | Mode A | Mode B |
|---|---:|---:|
| Updater runs (all succeeded) | 2,859 | 2,859 |
| CPU time of the runs, share of one core | 0.945 % | 0.895 % |
| CPU that the updater adds to the Shell service with its children | 0.504 % | 0.437 % |
| CPU that the updater adds to `gnome-shell` alone | 0.418 % | 0.362 % |
| Trend of the post-GC anonymous PSS (the control: 45.9 KB/h) | 840.2 KB/h | 2,251.2 KB/h |
| Added growth of the raw PSS | 15,742.4 KB | 28,470.2 KB |
| Added growth of the post-GC anonymous PSS | 18,263.1 KB | 50,704.5 KB |

The old check 5 fitted a straight line to the samples of each session and
subtracted the slope of the control. Its limit was 1 % of the control PSS,
1,498.1 KB of growth.

Result:

- The CPU part of check 5 passed for both modes.
- The PSS part of check 5 failed for both modes: raw PSS, raw anonymous
  PSS, post-GC PSS, and post-GC anonymous PSS.
- All other checks passed.

## Root cause

The growth is free memory that glibc keeps inside `gnome-shell`. It is not a
leak of picture objects.

1. Each picture change makes new picture buffers in `gnome-shell`, one unit
   each. The buffers of the old picture become dead.
2. The Shell frees a dead picture only when the GC frees its JS wrappers.
   One GC pass does not free all of them.
3. After the first free of an 8 MB block, glibc raises its mmap threshold
   above 8 MB. After that, the picture buffers come from the main heap.
4. glibc keeps the freed heap memory, and gives back only the top of the
   heap. So the heap stays at the largest number of live plus dead buffers
   at one time.
5. The level rises to a plateau. Then it moves up and down in steps of one
   unit.

The evidence comes from an investigation with the test session: one
picture change every 2 s, Fedora 44, software rendering.

- **mmap threshold.** `MALLOC_MMAP_THRESHOLD_=131072` makes glibc give each
  freed buffer back to the system. With it, the level after three proven
  GCs rose by 1.1 units in 4,176 changes. With the default allocator, it
  rose by 45.9 units in 4,175 changes.
- **`malloc_trim(0)`.** At the end of the default run, gdb called
  `malloc_trim(0)` in the Shell. The anonymous PSS went from 544,888 KB to
  154,180 KB. Before the trim, 373.8 MB of the 475.9 MB main heap was free
  (79 %).
- **3-GC levels.** On average, the second and third GC passes freed 2.0 to
  6.0 units more than the first pass. With two proven GCs after each
  change, the level stayed at +6 to +9 units, not at about +46 units.
- **Plateau.** In the default run, the level reached its largest value
  (+52.9 units) at 1,115 changes. It did not go above that value in the
  next 3,000 changes. In the 24-hour soak, both modes reached the plateau
  at about 12 h (see the table).

Post-GC anonymous PSS of the soak, lowest to highest value in each 6-hour
window (KB):

| Session | 0 to 6 h | 6 to 12 h | 12 to 18 h | 18 to 24 h |
|---|---|---|---|---|
| Mode A | 188,056 to 220,404 | 139,516 to 220,372 | 205,456 to 245,896 | 204,424 to 228,604 |
| Mode B | 180,456 to 196,556 | 156,200 to 213,200 | 222,052 to 230,352 | 213,996 to 222,180 |
| Control | 113,932 to 113,964 | 113,932 to 113,964 | 113,932 to 113,984 | 113,964 to 114,992 |

- In the last 11 probes, the post-GC slope was negative: -1.32 MB/h for
  mode A and -0.84 MB/h for mode B.
- The positive trend of the old check came from the rise in the first
  hours.
- The gap to the control (about 100 MB) does not measure the kept memory.
  The control shows the default Fedora wallpaper, not the map.

After the trim, the runs that kept one file name (rename, in-place, and
rename with two GCs after each change) were at 153,440 to 154,180 KB. The trimmed control was at
134,160 KB. The trimmed run with the mmap threshold (4,176 changes) was at
130,856 KB, below the control. So the difference of about 2.5 units is
probably allocator residue, not live picture data.

## Why mode B looked worse

- Mode B changes the picture only about 14 % less often than mode A. The
  CPU time of a run shows a new picture (260 ms or more): about 2,469 of
  2,859 runs in mode A (86 %), and about 2,116 runs in mode B (74 %).
- From hour 12, both modes are in the same range: 204,424 to 245,896 KB
  for mode A, and 213,996 to 230,352 KB for mode B.
- Mode B started lower. In the first 12 h, many of its probes were at 176
  to 184 MB. So a straight line over all 23 probes has a steeper slope for
  mode B. This is an effect of the line fit, not of a different behavior.
- In the steady state, both modes rename over the same file and write no
  settings key.

## The new check

### The probe

Once per hour (`GNOME_TEST_SOAK_GC_INTERVAL`, default 3600 s), the sampler
of each session makes one probe:

1. In a session with the updater, the probe waits until a run of the
   updater ends (60 s at most), and then 5 s more. A run starts every 30 s
   and takes about 0.5 s. So the next run usually starts after the probe.
2. It records the sample "before".
3. It makes three proven GC passes, 2 s apart. The proof is the WeakRef
   proof of the first soak: an object that only a `WeakRef` holds is gone
   after `imports.system.gc()`.
4. It asks the host for `malloc_trim(0)` in `gnome-shell`.
5. It waits 5 s and records the sample "trim". This sample is the live
   memory.

The timer keeps its cadence, so a run can start during the probe. Its
picture change then puts dead buffers in the samples. So the probe checks
the updater service:

- It reads the `InvocationID` and the `ActiveState` of the service at the
  start and at the end.
- A run overlapped the probe if the `ActiveState` is not `inactive` or
  `failed` at the start or at the end, or if the `InvocationID` changed.
  A start read with no `InvocationID` also counts as an overlap, unless
  its `LoadState` is `not-found`. The control container gives
  `not-found`. A read that fails (a bus error, or a user manager that does
  not answer) gives no line at all, so it counts as an overlap.
- The sampler then discards the sample and makes the probe again (steps 1
  to 5), 3 tries at most. `sampler.log` gives the duration of each
  discarded try. The before and one-GC samples of a retried try follow
  the trim of the earlier try, so the one-GC trend, which is not judged,
  mixes trimmed and untrimmed probes.
- After 3 overlaps, the probe records "updater overlap". This probe fails
  the data check.
- A probe with a failed trim fails the data check anyway. So the sampler
  keeps that try and does not try again, and the summary gives the reason
  of the trim failure.
- The last probe starts 720 s before the end at the latest. This margin
  covers 3 tries of 240 s when the Shell answers its Evals. A Shell that
  does not answer its Evals can make a probe take longer.

`gc.tsv` records the result of each GC pass, the number of proven passes,
the trim result, and four samples: before, after the first GC, after the
third GC, and after the trim. The sampler still records a raw sample every
60 s.

### Where the trim runs

- The sampler (`tests/gnome/soak-sampler.sh`) runs inside the container, as
  a system service of the container. The test image has no gdb.
- So the host makes the trim. The sampler writes a request to its output
  folder. `tests/leak/soak.sh` on the host reads it and runs the host gdb
  with the call of the investigation:
  - gdb attaches to the host PID of `gnome-shell`;
  - it uses the libraries of the container (`set sysroot /proc/<pid>/root`);
  - it calls `malloc_trim(0)` and detaches;
  - it runs in batch mode with a time limit of 120 s.
- In the soak, `gnome-shell` runs as the test user, a subordinate UID of
  the host user. In the investigation, it ran as root of the container. So
  two things are different:
  - gdb runs in the user namespace of rootless Podman (`podman unshare`).
    Outside that namespace, gdb can attach, but it cannot read the memory
    of the Shell. Then it finds no libraries and no `malloc_trim`.
  - `podman top` shows no host PID for the processes of the test user. So
    `soak.sh` reads the host PID from the `NSpid` line of
    `/proc/<pid>/status`.
- The trim runs only in the test session. Nothing in `core/`, `updater/`,
  `systemd/`, or `install.sh` changes.
- If gdb is missing or the call fails, the probe records the failure and
  its reason.

### The rule

`tests/leak/summarize.js` judges each session with the updater against the
control:

1. Use the post-trim anonymous PSS of the good probes after the warm-up. A
   good probe has three proven GC passes, a trim that ran, and no updater
   overlap.
2. Split the soak into two halves of equal time.
3. Take the largest value of the second half minus the largest value of
   the first half.
4. Subtract the same difference of the control.
5. Pass: the result is 2 units (16,200 KB) or less.

Other parts of check 5:

- A probe fails the data check if it has fewer than three proven GC
  passes, if it has no good trim, or if an updater run overlapped each of
  its 3 tries. The summary lists the reason, and the sample does not count.
- The probes must cover the soak: a probe every interval, with 720 s of
  lateness allowed (3 tries of 240 s) and 720 s at the end. The summary
  fails the data check, with the reason, if the probes do not cover it.
- The CPU part of check 5 does not change: the updater adds less than 1 %
  of one core to the Shell service with its children.
- The summary prints the raw trends and the one-GC trends as information.
  It does not judge them, because they also count the memory that glibc
  keeps.

Reasons:

- A line fit cannot tell a plateau from a leak when the plateau comes late
  in the soak. The largest values of the two halves compare the two
  ceilings. A leak raises the ceiling of the second half.
- The trim removes the free memory that glibc keeps. Three proven GC
  passes free the dead pictures. So the sample shows the live memory.
- The trim does not remove all free memory. In the investigation, the
  trimmed runs stayed about 2.5 units above the trimmed control, probably
  as allocator residue. The limit of 2 units gives room for steps of this
  residue.

The limit of the rule: for a steady leak, the two largest values are about
12 h apart. So the rule finds a leak of more than about 2 units in 12 h.
With about 103 picture changes per hour in mode A, that is about 13 KB for
each picture change.

## Deadlock risk

GNOME Shell can deadlock: its main thread blocks for good. In a real
session, the Shell is the compositor, so the whole desktop freezes.

- The cause is a known GJS lock cycle between the toggle queue lock and the
  GSettings backend lock. The same cycle is in
  [linuxmint/cjs pull request 140](https://github.com/linuxmint/cjs/pull/140),
  a fix for the GJS fork of Cinnamon. We did not find a fix in GJS.
- The main thread holds the toggle queue lock during a GC. It drops a
  `GSettings` object and waits for the GSettings backend lock. At the same
  time, the dconf worker thread holds the backend lock and waits for the
  toggle queue lock.
- The deadlock needs a dconf write by any program while the Shell frees an
  old picture. Each new background of the Shell makes a `GSettings` object,
  so each picture change gives the GC one more of them to drop.
- The steady state of the updater writes no key. The updater writes the
  wallpaper keys only when they do not point to the live picture.

Rates in the test session, with one dconf write after each picture change
(every 2 s):

| Allocator | Runs | Changes | Deadlocks |
|---|---:|---:|---:|
| With the mmap threshold | 4 | 1,894 | 4 of 4 runs (after 63 to 798 changes) |
| Default | 6 | 7,093 | 0 |

- With 0 deadlocks in 7,093 changes, the 95 % upper limit of the rate with
  the default allocator is about 1 in 2,400 changes. The rate is not shown
  to be zero.
- Without a dconf write after each change, no run deadlocked: 14,311
  changes.
- Issue [#10](https://github.com/p5ych0/gnome-air-raid-map/issues/10) tracks
  this risk.

## The cost of a new picture name

The Shell `BackgroundCache` adds one file monitor for each file name and
never removes it. The cost is about 14 KB for each new name. This value is
an estimate: after the trim, a run with a new name at each change was
23.5 MB above the in-place run for 1,669 names.

The updater uses a new name only in three cases:

- at the first run;
- after the failure banner;
- after a change of the wallpaper by the user.

A normal update keeps the name, so the steady state has no such cost.

## Limits of the measurements

- All runs used software rendering (llvmpipe). With a GPU, the pictures can
  be in GPU memory or in driver memory. The plateau can then be different.
- All runs used the Fedora 44 image (GNOME 50, GJS 1.88.1, glibc 2.43). We
  did not test Ubuntu 24.04 (GNOME 46).
- Animations were off, so GNOME did not fade between pictures.
- The test session is not a real login session. A real session has other
  programs that write dconf keys.
- The rate of the deadlock with the default allocator over days is not
  known.
