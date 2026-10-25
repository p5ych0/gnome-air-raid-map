# Decision: CPU budget of a run, and the trust store

Date: 2026-10-24. Task 11b, after plan Task 11. Spec section 3.1, goals 5
and 6, and section 7.4, check 1.

## Decision

1. **We measure goal 5 on a quiet machine, and each set records the
   load.** For example, a set records the 1-minute load average every 10
   seconds. A run that uses more CPU time because other programs load the
   machine does not decide goal 5, but the record shows it.
2. **The owner accepted the small margin of goal 5 for three different
   monitors at the size cap.** On a quiet machine, a run uses up to 0.95 s
   of CPU time. When other programs load the machine, a run uses up to about
   1.3 s. This layout gets an optimization only after real user experience
   shows a need.
3. **The updater trusts the system CA file on every distribution.**
   `updater/net.js` loads `/etc/ssl/certs/ca-certificates.crt` for the HTTPS
   requests. If it cannot load that file, it uses the default trust store.
   On Fedora, the file replaces the p11-kit trust store. The owner accepted
   this on 2026-10-24.

Reasons:

- The same work uses more CPU time when other programs run on the same
  cores (shared cores and a lower clock). In the busy parts of one set, the
  same runs used about 30 % more user time. See "Three different monitors
  at the size cap". Goal 5 is about the work of the updater, so a quiet
  machine gives the correct number.
- A run of more than 1 s under load does no harm. The service limit
  `TimeoutStartSec=25s` limits the wall time of a run, not its CPU time.
- At the size cap, the largest cost is the PNG encoding (about 295 ms, 57 %
  of a run). Cairo in GJS has no option for the zlib level or the PNG
  filter. A faster encoder needs access to the pixels, and only GTK gives
  that access. Spec 5.2 does not allow GTK.
- On Fedora, the p11-kit trust store costs about 64 ms of CPU time in each
  run that uses TLS. The CA file costs 6 to 8 ms. Goal 6 went from about
  0.9 % to 0.68 % of one core (see "Against NEPTUN"). The 0.68 % was
  measured with the prepared boundaries (the second change below), which
  were removed later. Without them, the estimate is about 2 % more updater
  CPU: about 0.70 % of one core.

## Changes of Task 11b

A profile of the run chose three changes (changes 1, 2 and 3):

- `updater/net.js`: the system CA file instead of the p11-kit trust store
  (see "Trust store").
- `updater/store.js`: the prepared boundaries next to the boundary cache.
  In Task 11b, the boundary steps of a run took 11.5 ms of CPU time, not
  17 ms. **This change was removed on 2026-10-25, in the review of PR 11.**
  The review required checks of the stored points and centers. With these
  checks, the prepared boundaries saved only about 1 ms for each run, so
  they did not pay for their file format and their checks. Each run now
  parses and projects the boundary files again. The medians of the boundary
  steps, 78 runs of each, measured at the same time:
  - without the prepared boundaries: 17.9 ms;
  - with the prepared boundaries of Task 11b: 12.9 ms;
  - with the prepared boundaries and the checks of the review: 16.9 ms.
- `core/render.js`: a monitor with the size and scale of an earlier monitor
  gets a copy of its pixels. At the size cap with two equal monitors, the
  drawing takes 120 ms, not 203 ms.

## Results

All sets ran on one host: Fedora 44, 16 cores, GJS 1.88.1. The NEPTUN pairs
ran in the Fedora 44 test image. "Before" is the branch before Task 11b, and
"after" is the branch with the three changes. Change 2 (the prepared
boundaries) was removed later. So each "after" value includes its gain of
about 5 ms for each run, and a run of the current branch uses about 5 ms
more CPU time.

### 1,000 runs against the fixture server

Command: `tests/leak/run-many.sh 1000 <layout>`. The before tree and the
after tree ran at the same time, so both had the same load. The three
containers of the 24-hour soak also ran. During the 1920×1080 sets, three
other test containers ran too, so these numbers are a little high.

| | 1920×1080 before | 1920×1080 after | Cap, two equal 4K monitors, before | Cap, two equal 4K monitors, after |
|---|---:|---:|---:|---:|
| Exit codes | 1,000 × 0 | 1,000 × 0 | 1,000 × 0 | 1,000 × 0 |
| CPU mean (s) | 0.241 | 0.239 | 0.588 | 0.507 |
| CPU p99 (s) | 0.35 | 0.35 | 0.66 | 0.57 |
| CPU max (s) | 0.40 | 0.37 | 0.74 | **0.62** |
| Peak RSS max (KB) | 76,140 | 78,636 | 134,088 | 137,532 |
| Peak RSS limit of goal 5 (KB) | 122,880 | 122,880 | 204,800 | 204,800 |

The cap layout is `3840x2160@1,3840x2160@1`. The fixture server uses HTTP,
so the trust store change has no effect in these sets. The 1920×1080 layout
has one monitor, so the monitor copy has no effect there.

On another day, Task 11 measured the cap layout before the changes at a max
of 1.24 s. The numbers change from day to day.

On 2026-10-25, after the removal of change 2, one more set of 1,000 runs
ran at 1920×1080. The soak containers ran, but no other test ran. The
1-minute load had a median of 2.09 and a max of 2.65.

- Exit codes: 1,000 × 0.
- CPU: median 0.210 s, mean 0.212 s, p99 0.25 s, max 0.31 s.
- Peak RSS: max 76,892 KB, mean 73,607 KB.
- `summarize.js`: PASS for all four checks.

During the 1920×1080 sets of the table, three other test containers also
ran, so the two do not compare directly.

### Three different monitors at the size cap

Layout: `3840x2160@1,2560x1440@1,1920x1080@1`, scaled down to the size cap.
This layout draws three maps and has no monitor to copy. It is the costliest
layout at the cap.

| Set | Load (1-minute average) | CPU median (s) | CPU max (s) | Runs of 1 s or more |
|---|---|---:|---:|---:|
| 15 runs, before | not recorded | 0.62 | 0.80 | 0 |
| 15 runs, after | not recorded | 0.62 | 0.66 | 0 |
| 1,000 runs, after, with other jobs | 4.9 at the start, 10.9 at the end | 0.69 | 1.29 | 48 |
| 1,000 runs, after, load recorded every 10 s | median 3.42, max 9.33 | 0.65 | 1.04 | 10 |

- **The set with other jobs.** The three soak containers, two other test
  containers and the jobs of other projects ran on the machine. The runs
  of 1 s or more came in groups. In the quiet blocks of 50 runs, the max
  was 0.70 to 0.86 s. In the busy blocks, the user time went up by about
  30 %.
- **The set with the recorded load.** All 10 runs of 1 s or more were in
  runs 1 to 50, while the load went up to 9.3. In runs 51 to 1,000 (load
  7.4 or less), the max was 0.95 s and the mean was 0.658 s. This is the
  value of goal 5 for this layout: about 5 % below the limit.
- The peak RSS max was 136,084 KB and 136,232 KB, below the limit of
  204,800 KB.

### Against NEPTUN (goal 6)

Command: `tests/gnome/run-systemd.sh fedora44 soak 1920x1080`, with
`GNOME_TEST_SOAK_SECONDS=2100`. `install.sh` installs the updater, and the
real systemd timer runs it every 30 s against NEPTUN for 35 minutes. The
before tree and the after tree ran at the same time in two containers. So
both had the same NEPTUN data and the same load. The share of one core is
the CPU time of all runs divided by the time from the first to the last
sample.

| | Pair 1 before | Pair 1 after | Pair 2 before | Pair 2 after |
|---|---:|---:|---:|---:|
| Runs (success) | 69 (69) | 69 (69) | 69 (69) | 69 (69) |
| CPU time of all runs | 19.30 s in 2,101 s | 14.31 s in 2,102 s | 18.60 s in 2,104 s | 14.32 s in 2,100 s |
| Share of one core | 0.919 % | **0.681 %** | 0.884 % | **0.682 %** |
| CPU per run, mean (s) | 0.280 | 0.207 | 0.270 | 0.208 |
| CPU per run, max (s) | 0.512 | 0.341 | 0.429 | 0.340 |
| MemoryPeak mean (MB) | 47.5 | 34.5 | 47.9 | 35.6 |

During pair 1, other tests of Task 11b also ran. During pair 2, no other
test of Task 11b ran. At 1920×1080, the trust store is most of the gain.
The monitor copy has no effect on one monitor, and the prepared boundaries
saved about 5 ms for each run.

The "after" values were measured with change 2. Change 2 was removed
later, so the current branch uses about 5 ms more CPU time for each run.
That is about 2 % more updater CPU: the estimate is about 0.70 % of one
core, not 0.68 %.

## Trust store

On Fedora, GnuTLS reads its system trust store through p11-kit. The p11-kit
trust module then reads `/usr/share/pki/ca-trust-source/ca-bundle.trust.p11-kit`
(2.6 MB) in each run. This costs about 64 ms of CPU time in each run that
uses TLS. A `Gio.TlsFileDatabase` of the CA file costs 6 to 8 ms. In the
Fedora 44 test image, a run against NEPTUN used about 57 ms less CPU time
with the CA file.

What the updater does:

- For an HTTPS API base, `createSession` loads the CA file with
  `Gio.TlsFileDatabase.new()`. It sets the database for the session and as
  the default database of the process. glib-networking reads the default
  database before Soup gives the connection the database of the session, so
  both settings are necessary.
- If the load fails (the file is missing, empty, unreadable or not valid),
  the updater keeps the default trust store. No code path turns off the
  certificate check.

On Debian and Ubuntu, GnuTLS already uses this file as its default trust
store, so nothing changes there. `update-ca-certificates` writes the file.

On Fedora, the file is a link to
`/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`. `update-ca-trust`
extracts this bundle from the p11-kit sources, so the trusted CAs are the
same. The CA file has two differences from the p11-kit trust store:

- The PEM file cannot hold the p11-kit distrust records for intermediate
  certificates. So the updater does not use these records.
- When an administrator changes the trust sources, the PEM file stays old
  until `update-ca-trust` runs.

The owner accepted these differences on 2026-10-24. Without this change,
goal 6 is at about 0.88 to 0.92 % of one core against NEPTUN on Fedora.

## Limits of the measurements

- All sets ran on one host and in one test image. Another computer gives
  other numbers.
- The NEPTUN pairs are 35 minutes long, at 1920×1080.
- The 15-run sets of the three-monitor layout ran with a profile copy of
  the program. They did not record the load.
