# Making the host binary fail like the board: prior art and a plan

Status: research record, 2026-08-02. Companion to
[fable-esp32-offdevice-rig-prior-art-2026-07-31.md](fable-esp32-offdevice-rig-prior-art-2026-07-31.md),
which surveyed deterministic _unit-level_ rigs at sans-I/O seams. This document
answers a different question: the macOS target
(`firmware/targets/host_cli/`) is a whole live binary running the same core C
against the real platform, it found eleven defects, and it still cannot see a
class of bug that the ESP32 hits routinely. What is the prior art for making a
host-run binary fail like embedded hardware, and what is the smallest thing we
should build?

The headline: **the missing faults are all reachable from four in-process
knobs on seams this repo already has. Do not reach for syscall interposition,
network shaping, or a virtual-clock rewrite — the first is fragile on modern
macOS, the second cannot express the fault we actually have, and the third
throws away the one property that makes `host_cli` valuable (it runs against
the real bridge, with real TLS, at real time).**

---

## 1. What the host target cannot currently see, in code

### 1.1 The device's reader is always waiting; the host's never is

`targets/waveshare_s3_amoled/main/main.c`, `playback_task`, says it plainly:

> The writer NEVER stops. That is the whole design.

Its loop is:

```c
if (!iterate_kit_voice_playback_clock_ready(&clock, bytes_available)) {
  DELAY_MS(5); continue;                      /* spin, 200x/s, sink still pulling */
}
received = xStreamBufferReceive(buf, chunk, sizeof(chunk), pdMS_TO_TICKS(20));
if (received == 0U) { ... CONCEAL -> waveshare_audio_write(silence); continue; }
...
waveshare_audio_write(chunk, received / 2U);  /* blocks on I2S DMA */
```

Cadence authority is the I2S DMA clock. The reader is _always_ blocked in
something: a 20 ms stream-buffer wait, or the I2S write itself. Every latch
that only fires while the reader waits is armed on every single frame.

`targets/host_cli/main.c`, `cli_main_poll_playback` + `cli_main_run_loop`:

```c
while (!stop) {
  now = cli_runtime_now_ms(NULL);
  iterate_kit_posix_itx_transport_poll(&t, CLI_MAIN_TRANSPORT_POLL_EVENTS /*16*/);
  cli_main_poll_playback(runtime, now);
  ...
  nanosleep(5 ms);
}

/* poll_playback */
if (now_ms < runtime->next_playback_at_ms) return;    /* free-running timer */
runtime->next_playback_at_ms += ITERATE_KIT_VOICE_FRAME_MS;
if (now_ms > stall_limit) runtime->next_playback_at_ms = now_ms + 20;  /* REBASE */
if (!iterate_kit_voice_playback_clock_ready(&clock, speaker.used)) return; /* return, not wait */
if (cli_speaker_read(...) != CLI_SPEAKER_OK) { cli_main_conceal_if_needed(...); return; }
cli_main_play_frame(...);   /* -> cli_wav_sink_write -> fwrite, never blocks */
```

Three differences, each disarming a class of defect:

1. **The sink never refuses.** `cli_wav_sink_write` (`cli_wav.c:166`) fails only
   on a 4 GiB RIFF overflow. There is no depth, no free-descriptor count, no
   "the DAC is still busy". The optional CoreAudio mirror _does_ have depth —
   8 preallocated `AudioQueueBuffer`s ≈ 160 ms (`cli_audio_out.h`,
   `CLI_AUDIO_OUT_BUFFER_COUNT = 8`) — but it is documented as "deliberately
   lossy": a full set increments `dropped` and returns `ERR_FULL`, and
   `cli_main_write_playback` discards the result with `(void)`. The one real
   backpressure signal on the host is explicitly thrown away.

2. **The tick is a timer, and the timer self-heals.**
   `CLI_MAIN_HOST_STALL_FRAMES = 4`: a stall past 80 ms rebases
   `next_playback_at_ms` to `now + 20`. The comment ("Host scheduler stalls
   remain visible but are never replayed as a burst") is right for a WAV
   witness and wrong for reproducing a device, where 80 ms of stall means the
   DMA ran dry and a listener heard it.

3. **`ready()` is sampled at 50 Hz, not spun at 200 Hz.** On device a false
   `ready()` costs `DELAY_MS(5)` and is retried while the DAC keeps pulling; on
   host it costs a `return`. The `answer_done` latch fixed in `79eb222b2` lived
   exactly there — on device the speaker task "span on an empty buffer for the
   rest of the session", a shape the host loop structurally cannot produce.

### 1.2 The ring never visits the region where the interesting code lives

`iterate_kit_voice_playback_clock_ready` returns false only while `priming` and
`queued_bytes < ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES` — 12 480 bytes, i.e.
**390 ms, 19.5 frames** (`voice_device_profile.h:89`).

The downlink arrives in **batches of up to 12 events = 240 ms of audio**
(`voicelab_stream.c`, `max_events = 12`), and `batch_dispatch` walks the array
calling `on_speaker` for every event _before it returns_. Two batches inside
two consecutive 5 ms loop iterations clear prefill.

On the device the same code measured 5.7 batches/s — 1.37× realtime, and only
after the mu-law change (`353914631`); before it, 9–31 frames/s against the 50
realtime needs. On the host the transport is polled 200×/s with
`NETWORK_RECEIVE_BURST = 8` chunks per pass and a 16-message application
budget, over a fast socket. `priming` ends in the first ~40 ms of an answer and
never returns except on an explicit `reprime`.

So on the host, `queued_bytes` lives near "the whole answer" inside a 960 000
byte (30 s) ring. The interesting region — 0 to 390 ms, where `ready()`,
`empty()`, `CONCEAL`, `DROP_DEBT`, and the `starve_at_ms` underrun detector all
live — is never visited. `docs/waveshare-open-defect.md` records exactly this:

> The CLI never showed either, because a Mac socket delivers 50 f/s without
> trying and its "reader" is a file write.

### 1.3 Deadlines that a throttle would reach, and today cannot

Every one of these is an `iterate_kit_voice_elapsed_ms(now, since) > LIMIT`
comparison, and none is reachable in a healthy host run:

| Rule                                                           | Constant                                                                                  | Where                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| downlink lane silent → recycle, then transport restart after 3 | `ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS = 10000`, `CLI_MAIN_RECYCLES_BEFORE_TRANSPORT = 3` | `cli_main_supervise_downlink`     |
| no bridge event → call declared gone                           | `ITERATE_KIT_VOICE_BRIDGE_SILENCE_MS = 20000`                                             | `cli_main_supervise_bridge`       |
| ping unanswered → transport restart                            | `ITERATE_KIT_VOICE_PING_TIMEOUT_MS = 20000`                                               | `cli_main_supervise_liveness`     |
| no liveness at all → process re-exec                           | `ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS = 180000`                                       | `cli_main_supervise_liveness`     |
| turn overdue → finish anyway                                   | `ITERATE_KIT_VOICE_TURN_MAX_MS = 30000`                                                   | `cli_main_finish_answer_if_ready` |
| conceal budget exhausted → back to priming                     | `ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS = 400`                                        | `voice_playback_clock_empty`      |
| connection push budget → recycle                               | `ITERATE_KIT_VOICELAB_RECYCLE_AFTER_BATCHES = 600`                                        | `voicelab_stream.h:56`            |

`iterate_kit_voice_elapsed_ms` exists _because_ of the fourth defect class. Its
comment is the specification for the clock-jitter knob:

> A loop samples `now` once at the top and checks its deadlines at the bottom;
> in between it polls the network, and an arriving batch stamps its own, later,
> reading. One millisecond of ordinary progress inside a single iteration was
> enough: measured on a healthy session with a 78 ms round trip, the call was
> declared gone and restarted, over and over, forty-two times in three minutes.

### 1.4 The seams that already exist

| Seam                | Where                                                                                         | Shape today                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clock               | `cli_runtime_now_ms(void *context)` (`main.c:207`)                                            | already a function pointer in `iterate_kit_voicelab_options.now_ms` with a `clock_context`; but `context` is ignored and everything else calls `cli_runtime_now_ms(NULL)` directly |
| Second clock        | `monotonic_microseconds()` (`posix_itx_transport.c:24`)                                       | independent `clock_gettime` — **the only other first-party host call site**                                                                                                        |
| Downlink events     | `on_speaker` / `on_control` / `on_transcript`, invoked from `batch_dispatch`                  | synchronous per-event, carries `struct iterate_kit_playout_frame`                                                                                                                  |
| Byte stream         | `iterate_kit_posix_tls_stream_read/write` (`posix_tls_stream.h:81`)                           | already returns `PROGRESS` / `WOULD_BLOCK` / `FAILED`                                                                                                                              |
| Poll budgets        | `CLI_MAIN_TRANSPORT_POLL_EVENTS = 16`, `NETWORK_RECEIVE_BURST = 8`, `NETWORK_SEND_BURST = 4`  | hard-coded constants                                                                                                                                                               |
| Audio sink          | `cli_wav_sink_write`, `cli_audio_out_write`                                                   | unbounded / lossy-and-ignored                                                                                                                                                      |
| Audio source        | `cli_wav_source_frame` (`cli_wav.c:117`)                                                      | `fread`, paced by `cli_main_poll_microphone`'s own 20 ms timer                                                                                                                     |
| Rings               | `cli_speaker`, `cli_microphone`, `iterate_kit_spsc_ring`                                      | already device-sized from `voice_device_profile.h`                                                                                                                                 |
| Flags               | `CLI_OPTIONS_FLAGS[]` table (`cli_options.c:65`)                                              | one line per flag; help text generated from the table                                                                                                                              |
| Per-second evidence | `cli_main_pulse` emits `loops/outbox/sent/frames/batches/rx/gaps/played/conceal/under/ringMs` | **the same pulse line the device emits**                                                                                                                                           |

That last row matters more than it looks: the acceptance test for a knob
setting is "the CLI's pulse line now looks like the device's pulse line". We
already have the oracle.

---

## 2. Prior art

### 2.1 Deterministic simulation testing, and why it is the wrong tool _here_

**FoundationDB** is the canonical example. Its C++ is written in **Flow**, an
actor-language extension compiled to state machines, so the entire database —
every node, every disk, every network link — runs as callbacks on a single
thread against an `INetwork` interface. In simulation mode that interface is
`Sim2`, which owns a virtual clock and jumps to the next scheduled event
instead of sleeping. Faults (machine reboots, disk corruption, network
partitions, clock skew, slow processes) are drawn from a seed, and a failing
run is reproduced by replaying the seed. On top of that sits **BUGGIFY**: a
macro placed at hand-chosen points in production code that does nothing in a
real build and, in simulation, fires with a probability to do something
pessimal — delay, reorder, choose the worst legal value, fail an allocation.

- Paper: _FoundationDB: A Distributed Unbundled Transactional Key Value Store_,
  SIGMOD 2021 — <https://www.foundationdb.org/files/fdb-paper.pdf>
- Testing docs incl. BUGGIFY: <https://apple.github.io/foundationdb/testing.html>
- Source: <https://github.com/apple/foundationdb>. Cite `release-7.3` paths
  (`flow/`, `fdbrpc/sim2.actor.cpp`, the `BUGGIFY` macro in
  `flow/include/flow/flow.h`) — they match the paper and every published
  account. At HEAD the actor compiler is being replaced by C++20 coroutines, so
  the file is `fdbrpc/sim2.cpp` and `BUGGIFY` is a `buggify()` function using
  `std::source_location` in `flow/include/flow/Buggify.h`.
- Will Wilson, _Testing Distributed Systems w/ Deterministic Simulation_,
  Strange Loop 2014 — <https://www.youtube.com/watch?v=4fFDFbi3toc>

The paper's **§4 Limitations** is the passage that decides our design, verbatim:

> Simulation is not able to reliably detect performance issues, such as an
> imperfect load balancing algorithm. **It is also unable to test third-party
> libraries or dependencies, or even first-party code not implemented in
> Flow.** As a consequence, we have largely avoided taking dependencies on
> external systems.

They meant it: FDB deleted its Apache Zookeeper dependency after fault
injection found two bugs _in Zookeeper_ that simulation could not reach, and
replaced it with a Paxos implementation written in Flow. _"No production bugs
have ever been reported since."_

**TigerBeetle** does the same in Zig, and is closer to our situation because it
is a single static binary with all memory allocated at startup. Its simulator
(`src/vsr/simulator.zig` and `src/testing/`) swaps in a deterministic `Time`, a
`Storage` that injects read/write latency, corruption and misdirected I/O, and
a `PacketSimulator` that partitions, delays, drops, duplicates and reorders.
Every run prints its seed; a seed is the whole reproduction.
<https://github.com/tigerbeetle/tigerbeetle>, and the _SimTigerBeetle_ film —
<https://www.youtube.com/watch?v=Vch4BWUVzMM>.

**Antithesis** (built by FoundationDB alumni) pushes the determinism down to a
hypervisor: your system runs unmodified in a deterministic VM, faults are
injected below the guest, and any failure is replayable instruction-for-
instruction. It also popularised the **"sometimes assertion"** — an assertion
that must hold _at least once_ across the exploration, which is how you state
"the ring should sometimes be empty". <https://antithesis.com/docs/>. Its
constraints matter for us: it takes a Docker Compose input and runs Linux
x86-64 guests.

Rust analogues, for shape: **madsim** (deterministic drop-in for tokio; used by
RisingWave) <https://github.com/madsim-rs/madsim>; **turmoil** (network
simulation for tokio) <https://github.com/tokio-rs/turmoil>; **shuttle**
(randomised concurrency testing using PCT) <https://github.com/awslabs/shuttle>;
**loom** (exhaustive interleaving of atomics/locks)
<https://github.com/tokio-rs/loom>. PCT itself: Burckhardt, Kothari,
Musuvathi, Nagarakatte, _A Randomized Scheduler with Probabilistic Guarantees
of Finding Bugs_, ASPLOS 2010. **Hermit**
(<https://github.com/facebookexperimental/hermit>) makes an arbitrary Linux
process deterministic by intercepting syscalls — the closest thing to "DST
without rewriting your code", and Linux-only.

**What DST demands of the code under test.** Synthesising across all of them:

1. one logical thread of control, or a scheduler you own;
2. every source of nondeterminism behind an injectable interface — clock,
   randomness, network, disk, and anything whose _address_ or _iteration order_
   can vary;
3. no direct syscalls from the code under test, including inside libraries;
4. bounded, up-front allocation (so allocator behaviour is not an input);
5. a single seeded PRNG that every decision derives from, printed on every run.

**How far is `host_cli` from that shape?** On (1) and (4) it is already there:
one cooperative loop, one static `struct cli_runtime`, no allocation after
init. On (2) it is halfway: the clock is a function pointer in one place and a
raw `clock_gettime` in two, the byte stream is an interface, the sink is not.
On (3) it is nowhere near, **and that is deliberate and correct** — the whole
value of this target is that it runs against the real bridge over real
OpenSSL. Making it deterministic means replacing the bridge with a fake, at
which point it stops being the thing that found eleven real defects and
becomes the unit rig that
[fable-esp32-offdevice-rig-prior-art-2026-07-31.md](fable-esp32-offdevice-rig-prior-art-2026-07-31.md)
already recommends building separately.

**Conclusion: take the vocabulary, not the architecture.** From DST we should
take: one seed, printed and recorded; faults expressed as a _schedule_ derived
from that seed; and "sometimes" assertions over a run. We should not take: a
virtual clock, a fake network, or an event-loop rewrite.

### 2.2 In-source fault injection ("failpoints")

The other major tradition puts named injection points _in your own source_ and
enables them by name at runtime.

- **FreeBSD `fail(9)`** — note the man page is `fail(9)`, _not_ `fail_point(9)`;
  the latter 404s. <https://man.freebsd.org/cgi/man.cgi?query=fail&sektion=9>,
  header <https://github.com/freebsd/freebsd-src/blob/main/sys/sys/fail.h>.
  `KFAIL_POINT_CODE(parent, name, code)` compiles to a cheap branch driven by a
  sysctl string grammar:

  ```
  [<pct>%][<cnt>*]<type>[(args...)][-> <more terms>]
  ```

  with nine types: `off`, `return`, `sleep`, `panic`, `break`, `print`,
  `pause`, `yield`, `delay`. `"2%5*"` means "2% of the time, but only 5 times
  total"; `->` cascades to the next term when this one does not fire. The
  CAVEATS section is written by people who got burned: _"It is easy to shoot
  yourself in the foot by setting fail points too aggressively or setting too
  many in combination."_ `delay` exists specifically because `sleep` is
  meaningless in a non-sleepable context — the analogue of our audio path.

- **TiKV's `fail` crate** — same grammar (`[p%][cnt*]task[(arg)]`, `->`
  cascade), configured from a `FAILPOINTS` environment variable.
  <https://github.com/tikv/fail-rs>. The disabled build is literally
  `macro_rules! fail_point { ($name:expr, $e:expr) => {{}}; }` — _"When
  failpoints are disabled, no code is generated by the macro."_
- **etcd's `gofail`** — failpoints as _comments_, rewritten in place by
  `gofail enable` and reverted by `gofail disable`; toggled at runtime over
  HTTP. <https://github.com/etcd-io/gofail>. Its underrated feature is
  `GET /<name>/count`, which reports how many times the failpoint actually
  fired — the difference between "we enabled the knob" and "the knob fired 47
  times".
- **libfiu** — the only C one. <https://blitiri.com.ar/p/libfiu/>,
  <https://github.com/albertito/libfiu>. Two things to take and one to avoid:
  - **Take `fiu-local.h`**: a vendored stub header defining
    `#define fiu_do_on(name, action)` to nothing unless `FIU_ENABLE` is set, so
    _"normal builds will not have a single trace of fault injection code"_.
  - **Take `fiu_set_prng_seed()`**: an explicit seed hook, because probabilistic
    firing without a seed is not reproducible.
  - **Avoid its hot path.** `fiu_fail()` takes a `pthread_rwlock_rdlock` plus a
    string-keyed hash lookup on _every_ call, even with zero failpoints
    enabled. There is no armed-flag fast path. Fine for a CLI tool; not fine on
    a frame path.
- **SQLite** — the exhaustive-fault doctrine, and the smallest implementation
  of it anywhere. <https://www.sqlite.org/testing.html>: _"OOM tests are done
  in a loop. On the first iteration the instrumented malloc is rigged to fail
  on the first allocation… the counter is increased by one and the test is
  repeated. The loop continues until the entire operation runs to completion
  without ever encountering a simulated OOM failure."_ Run twice — once
  failing only the *N*th, once failing everything after the *N*th. The
  injector itself is three lines (`src/util.c`), a single global function
  pointer, and call sites are **integer IDs, not strings**:
  `if( sqlite3FaultSim(400) ) return SQLITE_IOERR;`, with the rule _"the codes
  should not be changed or reused"_. Also worth stealing:
  `SQLITE_TESTCTRL_BENIGN_MALLOC_HOOKS`, an explicit concept of _faults that
  are injected but must not be scored as defects_.
- **curl** — `runtests.pl -t` counts the fallible calls in one run, then reruns
  the test once per call, failing each in turn. The injector (`lib/memdebug.c`)
  is one global countdown shared by exactly six sites (`malloc`, `calloc`,
  `strdup`, `wcsdup`, `realloc`, `socket`). Two details worth copying: the
  failure message prints a **paste-able reproduction** (`invoke with "-t$limit"
to repeat this single case`), and `--shallow=N` caps the reruns with a
  **month-stable random seed** so a rerun in the same calendar month picks the
  same subset. <https://curl.se/dev/runtests.html>
- **Linux kernel** — `failslab`, `fail_page_alloc`, `fail_make_request`,
  `fail_futex`, with debugfs knobs `probability`, `interval`, `times`, `space`,
  `verbose`, `task-filter`, plus stack-trace range filters. Two things matter
  for us. First, `/proc/<pid>/fail-nth`: write N, the N-th fallible call in
  that task fails — the in-kernel version of curl's torture loop, _"intended
  for systematic testing of faults in a single system call"_. Second, the doc
  states the discipline rule that generalises to every failpoint:

  > The function does not execute any code which can change any state before
  > the first error return.

  <https://www.kernel.org/doc/html/latest/fault-injection/fault-injection.html>

**The adaptation for this codebase.** Failpoint macros exist because those
projects inject faults at _call sites buried in logic_. We do not have that
problem: every fault we want lives at an **interface** — a sink, a byte stream,
a clock, a delivery callback. So the right transfer is the _grammar, the
control surface, and the compile-out discipline_, not the macro:

- a small, composable intensity vocabulary per knob (rate, burst, gap,
  probability), settable from one place;
- **count every firing** (gofail's `/count`), so a green run can be
  distinguished from a run where the fault never triggered;
- **zero cost and zero presence when disabled** — the `fiu-local.h` stub-header
  pattern, plus a CI check that the release ELF contains no fault symbols
  (the one failure mode of that pattern is a translation unit that forgot the
  local header);
- prefer **count-based to probability-based on frame paths**. Linux says it
  outright: _"one-failure-per-hundred is a very high error rate… consider
  setting probability=100 and configure `interval`."_ At 50 frames/s a 1%
  failpoint fires every two seconds.
- put the failpoint **before any mutation**, per the Linux rule above, or you
  are not simulating a failure — you are creating a state the real world cannot
  produce, and you will spend a day debugging a bug that does not exist.

Concretely: put the fault in the _implementation of the seam_, not in a macro
sprinkled through `voice_playback_clock.c`. The core must stay byte-identical
to what ships, or the harness has changed the thing it is measuring.

### 2.3 Prior art specific to real-time audio

This is the richest and least-used vein, because it is exactly our problem.

**WebRTC** has, in-tree, everything the engineer asked for:

- `BuiltInNetworkBehaviorConfig` / `SimulatedNetwork`
  (`api/test/simulated_network.h`) — the knob set, current field names:
  `queue_length_packets`, `queue_delay_ms`, `delay_standard_deviation_ms`,
  `link_capacity` (a `DataRate`, defaulting to `Infinity`; it _used_ to be
  `link_capacity_kbps` with `0` meaning unlimited), `loss_percent`,
  `allow_reordering`, `avg_burst_loss_length`, `packet_overhead`,
  `forward_ecn`. The interface is pull-based and clock-agnostic
  (`EnqueuePacket` / `DequeueDeliverablePackets(receive_time_us)` /
  `NextDeliveryTimeUs()`), which is precisely why it drops into a virtual-time
  loop. Seeded: `SimulatedNetwork(config, uint64_t random_seed = 1)`. Burst
  loss is Gilbert-Elliott, derived from `avg_burst_loss_length`.
- **The arrival-schedule file is real and is trivially simple.**
  `modules/audio_coding/neteq/tools/rtp_jitter.cc` (151 lines) rewrites arrival
  times in an rtpdump from a text file: _whitespace-separated integers,
  milliseconds, one per packet, in packet order_. Its whole reader is
  `while (timing_file >> new_time) new_arrival_times.push_back(new_time);`, and
  **reordering is not a feature — it is what happens when your schedule is
  non-monotonic**, because the tool then sorts by the new time. A jittered
  downlink profile is a text file of integers that commits to git and diffs.
- **`NetEqInput` is an event schedule, not a data source.** Six virtual
  methods, of which three are `NextPacketTime()`, `NextOutputEventTime()`,
  `NextSetMinimumDelayInfo()`, plus a `NextEventTime()` returning their `min()`.
  `NetEqTest::RunToNextGetAudio` is then five lines: advance the clock to the
  next event, insert a packet if due, pull audio if due. The output cadence is a
  constant, `kOutputPeriodMs = 10`.
- `GlobalSimulatedTimeController`
  (`test/time_controller/simulated_time_controller.h`) — virtual time for a
  whole call. It works only because every timer goes through a
  `TaskQueueFactory`; the escape hatch for blocking waits is `ScopedYieldPolicy`,
  which `rtc::Event::Wait` calls before it blocks so the rest of the world can
  progress. Anything blocking on a raw pthread primitive deadlocks.
- `audioproc_f` — offline replay of the AEC/AGC/NS chain. Its best idea is
  `--custom_call_order_file`: a text file of `c`/`r` characters, one per API
  call, and its inverse `--output_custom_call_order_file` whose help text is
  _"Generate custom process API call order file from AEC dump"_. **Extract the
  real interleaving from a production recording, then replay that exact
  interleaving against synthetic fixtures** — nine lines of parser.
- Two under-known pieces: `NetworkConfigSchedule` (a proto of
  `{time_since_first_sent_packet_ms, ...knobs}` items plus
  `repeat_schedule_after_last_ms`), so one run can walk good → awful →
  recovered without restarting; and a golden-output pattern that asserts **two**
  checksums per test, the audio _and_ the network stats.

Source: <https://webrtc.googlesource.com/src/>

**GStreamer** has the closest analogue to a cranked clock. `GstTestClock` keeps
a sorted list of _pending clock ids_; advancing time releases nothing, and
releasing is a separate explicit call. **That gap between "advance to T" and
"release the waiter" is the entire jitter model** — advance exactly to `t` and
the wait is on time; advance to `t+7ms` and then process, and it is 7 ms late;
never process, and you have starvation for free. `gst_harness_crank_*` bundles
the three steps under one lock. Two structural facts: the harness uses the test
clock _by default_, and it answers `GST_QUERY_LATENCY` as live by default,
which is what puts the element under test on its real-time code path with no
network.
<https://gstreamer.freedesktop.org/documentation/check/gstharness.html>

Two corrections to the folklore, both load-bearing:

- **`identity`'s `datarate` does not throttle.** It _retimestamps_
  (`GST_BUFFER_PTS = offset * GST_SECOND / datarate`). Throttling only happens
  if you also set `sync=true`, which then waits on those synthesised timestamps
  via `gst_clock_id_wait`. `sleep-time` is a raw `g_usleep` on the streaming
  thread, wall-clock, and exists to _induce_ downstream starvation.
- **`netsim`'s delay path is wall-clock and therefore cannot be driven
  deterministically.** It runs a private `GMainLoop` using
  `g_get_monotonic_time()`, its RNG is an unseeded `g_rand_new()`, and it even
  contains `if (current_time < netsim->prev_time) GST_WARNING ("Clock is going
backwards!!")`. That is why GStreamer's own jitterbuffer suite _fabricates
  arrival times by hand_ rather than putting `netsim` in front of the element.
  **This is the most important negative result in the survey: an impairment
  path that reaches for the monotonic clock directly is permanently
  undeterministic.**

**Which host "sound cards" actually apply backpressure.** Not all of them, and
the difference matters:

| Backend                            | Real-rate backpressure with no hardware? | Mechanism                                                                                                    |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| ALSA `null` PCM (`-D null`)        | **No**                                   | no timer at all; `avail` is always `buffer_size`. `aplay -D null` finishes a 10-minute WAV in under a second |
| `snd-dummy hrtimer=1` (default)    | **Yes**, ns-accurate, drift-free         | position derived from wall-clock delta × rate                                                                |
| `snd-aloop`                        | Yes, jiffy-granular                      | `mod_timer`                                                                                                  |
| `jackd -d dummy`                   | **Yes**                                  | `usleep` to an _anchored absolute_ deadline; xrun on overrun                                                 |
| PipeWire `support.null-audio-sink` | Yes                                      | `timerfd`, `SPA_FD_TIMER_ABSTIME`                                                                            |
| JACK / PipeWire freewheel          | **No — by design**                       | the driver is _swapped_, not branched                                                                        |

ALSA's `null` is the anti-pattern our WAV sink currently resembles. `snd-dummy`
is the reference implementation, and two of its design choices are worth
lifting: **data-discard and rate-pacing are orthogonal axes** (`fake_buffer`
vs `hrtimer`), and **pacing is a six-method vtable, not an `if`**. JACK and
PipeWire make the same point more strongly — freewheeling swaps the driver
object rather than branching inside it.

**Zephyr's `native_sim`** is the embedded analogue. Its time model:

> You can imagine the code executes in a simulated CPU which runs at an
> infinitely fast clock: **No time passes while the CPU is running.**

with `CONFIG_NATIVE_SIM_SLOWDOWN_TO_REAL_TIME` as the opt-in to real speed —
and note its default, `default y if BT_USERCHAN || !TEST`: **real-time slowdown
is on for interactive runs and off under the test runner.** `--rt-ratio` and
`--rt-drift` let simulated time run at a chosen multiple or a few ppm off, and
`--stop_at` is a deterministic simulated-time watchdog for free.
<https://docs.zephyrproject.org/latest/boards/native/native_sim/doc/index.html>

**And the single most directly transferable artefact in this entire survey:
Zephyr ships file-backed I2S and DMIC drivers for `native_sim`**
(`drivers/i2s/i2s_native_sim.c`, `drivers/audio/dmic_native_sim.c`, with
`--i2s_rxtx_tx=<path>` / `--dmic0_file=<path>` on the command line). This is
exactly K1, already written, by people solving exactly our problem. The pacing
function is ~15 lines:

```c
static void ns_i2s_pace(struct ns_i2s_stream *stream, size_t size)
{
	bytes_per_sec = ns_i2s_bytes_per_sec(&stream->cfg);
	deadline = stream->next_deadline_us;
	now = nsi_hws_get_time();
	if ((deadline == 0U) || (deadline < now)) {
		deadline = now;                 /* <-- drops accumulated debt */
	}
	duration_us = DIV_ROUND_UP((uint64_t)size * USEC_PER_SEC, bytes_per_sec);
	stream->next_deadline_us = deadline + duration_us;
	if (deadline > now) { k_usleep(MIN(deadline - now, UINT32_MAX)); }
}
```

Two of its deliberate limitations are the knobs we should expose rather than
inherit. It **drops deadline debt** rather than repaying it, so it models a
free-running codec and will _not_ reproduce "DMA delivered three buffers
back-to-back after a stall". And **TX starvation is a hard `-EIO`**, not a
glitch. Also worth contrasting with `drivers/dma/dma_emul.c`, which is a
work-queue plus `memcpy` with _no_ time model at all: fake peripherals come in
a contract-only flavour and a rate-modelled flavour, and only the second one
helps with jitter and starvation.

**The debt policy is the design decision, and three codebases make three
different choices** — none obviously right, all worth having as a knob:

| System                         | Policy                                                                                                                                   | Consequence                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Zephyr `ns_i2s_pace`           | **drop debt** (`if (deadline < now) deadline = now`)                                                                                     | free-running codec; never bursts to catch up                                        |
| JACK `JackTimedDriver`         | **anchor, absorb, and report** — deadline is `cycle_count × period / rate` from a fixed anchor; overrun emits a real xrun and re-anchors | slow cycles absorbed, not compounded; lateness is _visible_                         |
| pjmedia `clock_calc_next_tick` | **absorb under 500 ms, resync above it** (`MAX_JUMP_MSEC 500`)                                                                           | media timestamps stay exact until the jump is large, then media is permanently lost |

`host_cli` today does the Zephyr thing (`CLI_MAIN_HOST_STALL_FRAMES` rebases to
`now + 20`) _without the report_. The device does the JACK thing, because the
I2S clock is the anchor. **That mismatch is the second half of defect class 1**,
and it is why the rebase is a knob rather than a constant.

**A structural convergence worth naming.** Four independent codebases in four
languages arrived at exactly two time primitives, and all four document the
same caveat:

| Paced advance (smallest increments, ordering preserved) | Jump advance (instant, all timers ripe at once)                   |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| WebRTC `AdvanceTime`                                    | `SkipForwardBy` — _"simulating contention on destination queues"_ |
| Chromium `FastForwardBy`                                | `AdvanceClock`, `SuspendedFastForwardBy`                          |
| tokio `sleep` + auto-advance                            | `advance()`                                                       |
| GStreamer `crank`                                       | `set_time`                                                        |

They find different bugs; build both. Note also that all of them are
**forward-only** — none has a rewind, which is why backwards-time testing needs
a deliberately different mechanism.

**Clock perturbation** as a deliberate technique is less codified, but the bug
class is famous. Cloudflare's 2017 leap-second outage was exactly our defect —
a time delta that could be negative, in code that assumed it could not:
<https://blog.cloudflare.com/how-and-why-the-leap-second-affected-cloudflare-dns/>.
Go's decision to carry a monotonic reading inside `time.Time` exists for the
same reason. `libfaketime` (<https://github.com/wolfcw/libfaketime>) offers
offsets, speed-up factors and randomisation, but it targets wall-clock
(`CLOCK_REALTIME`, `time`, `gettimeofday`) rather than `CLOCK_MONOTONIC`, which
is the clock every deadline in this firmware uses — so it is the wrong
instrument for us even where it runs.

### 2.4 Searching the fault space: seeded swarm, not a full matrix

The single most useful result here is **swarm testing** (Groce, Zhang, Eide,
Chen, Regehr, ISSTA 2012 — <https://agroce.github.io/issta12.pdf>; Regehr's
summary <https://blog.regehr.org/archives/591>). Randomly _disabling_ a subset
of features on each run finds more bugs than always enabling everything. The
A/B is fixed-CPU-budget and blunt, verbatim:

> During one week of testing, the swarm machine found **104 distinct ways to
> crash compilers** in the test suite whereas the other machine — running the
> default Csmith test configuration, which enables all features — **found only 73.**

And the counterintuitive part: swarm found _42% more distinct_ crashes while
finding _30% fewer total_ crashes. It is not testing harder, it is testing
elsewhere.

The mechanism is the one that bites us. Their Table 6 shows pointers were both
the #1 _trigger_ (33% of bugs) and the #1 _suppressor_ (41% of bugs) — one
feature actively prevents other bugs from being reachable. Their own conclusion
is worth quoting because it is an argument against hand-tuning a matrix:

> Our intuitions (built up over the course of reporting 400 compiler bugs) did
> not serve us well in predicting which features would most often trigger and
> suppress bugs.

Applied here: a run with the sink paced _and_ the downlink throttled _and_ the
clock jittered _and_ the loop stalled will conceal continuously and restart
inside the first minute — and will therefore never spend twenty minutes in the
state where the `answer_done` latch bites. The loudest fault masks the subtlest
one. Draw a **random subset of knobs at random intensities per run**.

How many configurations? The paper gives the arithmetic: _"Even a very small
swarm set of 100 configurations is 95% likely to contain at least one Cᵢ for
any given choice of five features."_ With five knobs, ~100 seeded draws is
enough. Their one caveat, also worth obeying: _"a bad set can make testing less
effective"_, mitigated by _"include C_D in every swarm set"_ — i.e. **always
keep the everything-on configuration in the rotation**.

**FoundationDB does exactly this**, and its implementation is the clearest
model to copy. From `flow/include/flow/Buggify.h`, each buggification site is
activated **once per run** at 25% probability, memoised by `__FILE__`/`__LINE__`,
and then fires at 25% per hit — three nested gates, all randomness from
`deterministicRandom()`. The paper says so directly:

> Swarm testing is extensively used to maximize the diversity of simulation
> runs. Each run uses a random cluster size and configuration, random
> workloads, random fault injection parameters, random tuning parameters, and
> **enables and disables a different random subset of buggification points**.

TigerBeetle refines it further — sample the _weights_ rather than a binary
on/off, because _"picking things uniformly at random doesn't necessarily give
you interesting inputs"_
(<https://tigerbeetle.com/blog/2025-04-23-swarm-testing-data-structures/>).

**Reproduction discipline.** One PRNG, one printed seed, every fault decision
derived from it — and TigerBeetle's refinement that the key is **seed + commit**,
not seed alone. Two operational rules from them worth adopting verbatim: print
the seed _as a paste-able command line_, and print it _from the parent process_
so a crashed child still surfaces it. Be honest about what a seed buys here:
the bridge and the model are real, so the seed reproduces the **fault
schedule**, not the run.

**Minimisation.** For fault schedules specifically the prior art is DEMi (Scott
et al., NSDI '16 — <https://www.usenix.org/system/files/conference/nsdi16/nsdi16-paper-scott.pdf>),
which minimises faulty executions of distributed systems to "between 1X and
4.6X the size of optimal". Its three phases are literally the intuition
"fewer faults, later faults, shorter run": minimise external (fault) events
first, then internal event schedules, then message contents. Its central
heuristic — _"if one schedule triggers a violation, schedules that are similar
in their causal structure are likely to also trigger the violation"_ — is why
replaying a seed with one knob removed works. Underneath it is classical delta
debugging (Zeller & Hildebrandt, IEEE TSE 2002). For us the cheap version
suffices: replay the seed with each knob disabled in turn, then halve
intensities. Do not build `ddmin`.

**Evaluation methodology**, because a sweep that lies is worse than no sweep.
Klees et al., _Evaluating Fuzz Testing_, CCS 2018
(<https://arxiv.org/abs/1808.09700>) is the standard reference and its findings
apply directly: single runs mislead (one AFL run found 1200 crashes vs
AFLFast's 800; the _median of 30_ reversed it to 400 vs 1250), and short runs
mislead **with the sign reversing** — at 6 hours AFLFast beat AFL
significantly, at 24 hours AFL beat AFLFast significantly. Their advice for
exactly our case: _"Shorter times might be more useful in certain real-world
scenarios, e.g., as part of an overnight run during the normal development
process… These runs should consider at least a 24 hour timeout; performance for
shorter times can easily be extracted from such longer runs."_ Prefer fewer,
longer soaks to many short ones, and report medians over trials rather than a
single number.

Finally, **do not build coverage-guided search yet**. Wolff et al., _Greybox
Fuzzing for Concurrency Testing_, ASPLOS 2024
(<https://abhikrc.com/pdf/ASPLOS24.pdf>) measured feedback as worth ~6 extra
bugs out of ~46, and only on the hard tail: _"POS is comparable in efficacy to
our more structured search for finding relatively easy bugs. For harder bugs,
however, POS fails to find them as quickly or at all."_ At a few hundred runs a
night we are in easy-bug territory; blind seeded swarm is the right tool until
it stops finding things.

---

## 3. macOS constraints, verified on this machine

Verified on macOS 15.7.4 (24G517), arm64, **SIP enabled**.

| Technique                                                                | Works here?                                                   | What it buys                                                                                | Caveats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DYLD_INSERT_LIBRARIES` + `DYLD_INTERPOSE` on our own clang-built binary | **Yes** (verified)                                            | intercept `clock_gettime`, `write`, `read` with no source change                            | **Partial coverage:** verified that a direct call from our object is interposed while libsystem's own internal `time()`/`gettimeofday()` are not — the dyld shared cache is pre-bound. Also perturbs OpenSSL and CoreAudio, which you usually do not want. Does not work against Apple platform binaries or hardened-runtime apps.                                                                                                                                                                                                                                      |
| `libfaketime` / `faketime` (present at `/opt/homebrew/bin/faketime`)     | Partly                                                        | wall-clock offsets and speed-up                                                             | Targets `CLOCK_REALTIME`/`time`/`gettimeofday`; our deadlines are all `CLOCK_MONOTONIC`. Wrong clock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `dnctl` + `pfctl` (both present: `/usr/sbin/dnctl`, `/sbin/pfctl`)       | Yes, **with sudo**                                            | real bandwidth/delay/loss shaping via dummynet pipes attached to a pf `dummynet-anchor`     | Needs root and mutates host-wide network state; awkward to leave armed overnight. Cannot express "the delivery lane stopped existing while the socket stayed open", which is a _documented real_ defect here (`voicelab_stream.h`, `last_batch_ms`).                                                                                                                                                                                                                                                                                                                    |
| Network Link Conditioner                                                 | **Not installed**                                             | GUI presets                                                                                 | Ships in Xcode "Additional Tools", separate download; GUI-driven, not scriptable, host-wide.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tc netem`                                                               | **No**                                                        | —                                                                                           | Linux only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Toxiproxy                                                                | Not installed; would work                                     | `latency`, `bandwidth`, `slow_close`, `timeout`, `slicer` toxics; good at half-open sockets | It is a TCP proxy: you must re-point the endpoint, which breaks TLS hostname verification unless you run with `--insecure`. Keep for one job: half-open / silently-dead sockets.                                                                                                                                                                                                                                                                                                                                                                                        |
| `libfiu`                                                                 | **No — verified broken**, not merely unsuitable               | —                                                                                           | No Homebrew formula; the library will not link (GNU-ld-only `-soname`/`--version-script`); the preload half shells out to `ldd`; hand-linked, `fiu_enable()` segfaults in `wtable_set`. Its _in-source_ API is portable C and is the part worth studying (§2.2) — the shipped library is not usable here.                                                                                                                                                                                                                                                               |
| `rr` record/replay                                                       | **No — and not in a Linux VM either**                         | —                                                                                           | rr needs retired-conditional-branch hardware counters via `perf_event_open`; Apple's Hypervisor.framework does not virtualise the PMU, so a Linux guest has no `armv8_pmuv3` event source and rr aborts with _"Unknown aarch64 CPU type implementer: 0x61"_. `lldb` reverse execution is not merely unsupported but **unregistered** — `reverse-continue` is not a valid command. `dtrace`/`dtruss` are blocked by SIP.                                                                                                                                                 |
| CPU starvation                                                           | **Yes — `taskpolicy`, and it is much stronger than expected** | forces the process onto E-cores                                                             | Correcting the usual claim that macOS has no CPU lever: `nice` is inert (0.331 s vs 0.340 s baseline) and `cpulimit` is broken, but `taskpolicy -b` measured **11× slowdown solo and 28× combined with `stress-ng` load**, and it works on a _running_ process via `-p <pid>` — so it is a real mid-run fault, not just a launch option. `stress-ng` 0.21.04 is bottled and native arm64. A seeded `nanosleep` in our own loop is still preferable for reproducibility, but `taskpolicy` is the honest way to starve the whole process including OpenSSL and CoreAudio. |
| ASan / UBSan / TSan with Apple clang on arm64                            | **All three available** (verified)                            | memory and data-race truth                                                                  | **TSan on arm64 Darwin now works** — the old x86-64-only limitation is gone; it cannot be combined with ASan. **LSan, MSan, libFuzzer are not shipped** for this target; substitute `leaks --atExit`, `-ftrivial-auto-var-init=pattern`, and Homebrew LLVM. `libgmalloc` needs `MALLOC_STRICT_SIZE=1` or it silently misses one-byte overflows past non-16-aligned sizes. The repo already has `firmware/build-host-sanitized`.                                                                                                                                         |

The empirical headline: **everything the brief asks for is achievable
in-process, and every out-of-process option is either unavailable, needs root,
or cannot express the faults we actually measured.**

#### The interposition result in full, since it is the surprising one

Recorded so nobody re-derives it. Interposing dylib, built with plain `clang`,
no signing, no entitlements, SIP on:

```c
#define DYLD_INTERPOSE(_r,_e) \
  __attribute__((used)) static struct { const void *r; const void *e; } \
  _ip_##_e __attribute__((section("__DATA,__interpose"))) = \
  { (const void*)(unsigned long)&_r, (const void*)(unsigned long)&_e };

static int s_cgt(clockid_t id, struct timespec *ts) {
  int r = clock_gettime(id, ts);
  if (!r && ts) ts->tv_sec += 100000;
  return r;
}
DYLD_INTERPOSE(s_cgt, clock_gettime)
```

```
clang -dynamiclib -o libshim.dylib shim.c
DYLD_INSERT_LIBRARIES=$PWD/libshim.dylib ./victim
```

Observed:

```
direct clock_gettime -> 1785797983   <- intercepted (+100000)
libsystem time()     -> 1785697983   <- NOT intercepted
gettimeofday         -> 1785697983   <- NOT intercepted
```

So interposition reaches calls made _from our own objects_ and not calls made
inside the dyld shared cache. Independent verification sharpens this into the
rule that matters: **dyld rewrites cross-image symbol binds only.** A function
defined in the main executable cannot be interposed at all, and a call made
from inside a dylib to another symbol in that same dylib is untouched. For our
two `clock_gettime` sites that is technically sufficient (they are in our
objects, calling into libSystem) — but `cli_runtime_now_ms` itself is
uninterposable, and the same mechanism would silently perturb OpenSSL's and
CoreAudio's clocks while leaving libsystem's internal ones alone, giving a world
that is inconsistently wrong in a way no device is. A one-line seam is both
smaller and more honest.

Three practical notes if we ever do want interposition for something:

- **Link the shim in rather than using the env var.** `clang -o t t.c
./shim.dylib` applies the interposition with no `DYLD_INSERT_LIBRARIES`, which
  sidesteps hardened runtime, entitlements, and env-var stripping entirely. The
  entitlement matrix for the env-var route is unforgiving: under
  `codesign -o runtime` the shim is ignored unless **both**
  `allow-dyld-environment-variables` _and_ `disable-library-validation` are
  granted.
- `DYLD_PRINT_INTERPOSING=1` is the (undocumented) debugging lever.
- Your shim also catches the _runtime's_ calls — under ASan, `mach_absolute_time`
  was hit 17 times where app code made 1 call. Gate on a flag or you perturb the
  sanitizer too.

`write` interposition was also verified working (a shim returning short writes
truncated real output), which is worth remembering if a sink-refusal experiment
is wanted before `cli_sink_clock` exists. And it is worth knowing that
interposing `clock_gettime` _plus_ `sleep`/`nanosleep`/`poll` collapses a 13-second
test into 0.13 s of wall time with the program's own sense of time intact —
a genuinely powerful technique that **does not apply to `host_cli`**, because it
talks to a real bridge whose clock we cannot compress. That is the same
boundary §2.1 draws: virtual time and a real peer are mutually exclusive.

---

## 4. Recommendation

### 4.1 Principle, stated precisely

The brief says "platform seams should be adversarial by default". Adopt it with
one amendment: **adversarial by _availability_, honest by _default_.**
`host_cli` is not only a bug-finder, it is a measuring instrument — the prefill
constant in `voice_device_profile.h` carries the note _"measured on the CLI"_.
If the default configuration is hostile, every such measurement becomes
uninterpretable. So: every knob exists, every knob defaults to today's
behaviour, the unattended sweep is what turns them on, and **the report records
the fault configuration** so no number can be quoted without it.

### 4.2 Four knobs, and where each lives

Nothing goes in `components/core/`. The core must stay byte-identical to what
ships or the harness has changed the thing it measures.

**K1 — a sink that refuses. `--sink-rate F` (frames/s, float), `--sink-depth N`
(descriptors).**
New module `targets/host_cli/cli_sink_clock.{h,c}`: N descriptors of 20 ms
(default 8 ≈ 160 ms, mirroring `CLI_AUDIO_OUT_BUFFER_COUNT` and the device's
90 ms I2S lead), retiring at exactly `rate` frames per second of wall time.
`cli_sink_clock_acquire()` returns a `CLI_SINK_CLOCK_ERR_BUSY` status when none
is free, and `cli_main_poll_playback` must treat busy as _do not advance_. This
is a platform module, exactly as the device's I2S driver is — and per §2.3 it
should be a small vtable rather than an `if (paced)`, because the CoreAudio
variant below is the second implementation.

**`--sink-debt-policy {drop,anchor,resync}` is the knob that matters most**,
because it is the second half of defect class 1 and the three real systems
disagree (§2.3). `drop` is Zephyr `ns_i2s_pace` and is what `host_cli` does
today via `CLI_MAIN_HOST_STALL_FRAMES` — _without JACK's xrun report_, which is
the actual bug: a paced sink that silently falls behind hides the exact failure
it exists to expose. `anchor` is JACK: deadline `n × 20 ms` from a fixed anchor,
absorb slow cycles, and **emit a counted xrun on overrun**. `resync` is
pjmedia's `MAX_JUMP_MSEC 500`: absorb small overruns, resync and account the
lost media above the limit. The device is `anchor` (the I2S clock _is_ the
anchor); make `anchor` the default here and keep `drop` available so the
current behaviour stays reproducible.

Make the rate a **float** on purpose. The device's own comment says the bridge
and the I2S clock "are independent, so a small rate difference accumulates
without bound"; `--sink-rate 50.05` is the only cheap way to make that drift —
and therefore `DROP_CATCHUP` — reachable off-device.

Variant worth having, not defaulting to: `--sink=coreaudio`, which stops
ignoring `cli_audio_out_write`'s `CLI_AUDIO_OUT_ERR_FULL` and lets the real
8-buffer AudioQueue be the pacing authority. Highest fidelity, because a real
DAC does the pacing; unattended-hostile, because it makes noise.

_Catches:_ the `answer_done` latch, concealment-debt word deletion, the
`response.done`-as-barge-in bug — every defect that needs a genuinely paced,
genuinely waiting reader.

**K2 — a downlink that cannot keep up. Two layers.**

_K2a, the honest wall — `--link-bytes-per-second B`, `--link-messages-per-second M`._
In `platforms/iterate_posix/`, on `iterate_kit_posix_tls_stream_read` (which
already returns `PROGRESS` / `WOULD_BLOCK` / `FAILED` — the throttle needs no
new vocabulary, just a budget and a `WOULD_BLOCK`). This reproduces the
measured device ceiling directly: `voicelab_stream.h` records _"the taskless
control socket sustains ~25-50 TLS messages/s on-device"_. One function, no
core change, and it throttles control and audio together the way a real link
does.

_K2b, the precise instrument — `--downlink-rate F`, `--downlink-burst N`,
`--downlink-gap-ms MS`, `--downlink-loss PCT`, `--downlink-lane-death-ms MS`._
A small bounded queue of pending deliveries in `cli_main_on_speaker` (the
host's own boundary, not in shared `voicelab_stream.c`), releasing frames on
their due time from the poll loop. This is where jitter, clumping ("139 frames
in one second, then nothing") and loss are expressed. `--downlink-lane-death-ms`
is the one that matters most and is unobtainable from any external shaper: stop
delivering downlink events **without closing the socket**, which is the
documented failure where "the bridge appended eight call-accepted events and
eleven pongs, every one of them visible to another subscriber, while this
device's batch counter sat frozen at 77".

_Catches:_ sustained starvation; the `DOWNLINK_SILENCE_MS = 10000` recycle
ladder and the `RECYCLES_BEFORE_TRANSPORT = 3` escalation; `BRIDGE_SILENCE_MS`;
the `spkPlayed 90 / spkConceal 75` shape from `waveshare-open-defect.md`.

**K3 — a clock that is not perfect. `--clock-jitter-ms N`, `--clock-step-ms N`,
`--clock-step-every MS`.**
There are exactly **two** first-party `clock_gettime` call sites on the host
path — `targets/host_cli/main.c:211` and
`platforms/iterate_posix/posix_itx_transport.c:24`. Route both through one
`iterate_kit_posix_host_clock` in `platforms/iterate_posix/`, so the
perturbation is _shared_; perturbing only one invents a skew that is not a real
bug. Jitter must be allowed to make a later read return an earlier value —
that is the entire defect — but bounded to a few milliseconds so it stays a
model of scheduling, not of a broken clock.

Do this **in the seam, not with `DYLD_INTERPOSE`.** Interposition works here
(verified) but its coverage is partial in exactly the wrong way: it catches our
calls and misses libsystem's internal ones, while also perturbing OpenSSL and
CoreAudio. You would be debugging the harness.

_Catches:_ the whole unsigned-time family — every
`iterate_kit_voice_elapsed_ms(now, since) > LIMIT` in the table in §1.3. The
42-restarts-in-three-minutes defect would have fallen out of a single run at
`--clock-jitter-ms 2`.

**K4 — a loop that gets descheduled. `--loop-stall-ms MS`, `--loop-stall-every MS`.**
Three lines in `cli_main_sleep`: occasionally sleep 50–400 ms instead of 5 ms,
modelling "the display task ran", "the SD card wrote", "lwIP took the core".
Nearly free, and it is what turns K1 from a pacing model into actual
starvation. It also settles whether the `CLI_MAIN_HOST_STALL_FRAMES` rebase is
hiding anything.

_Plus one cheap fifth:_ `--outbox-slots N` to shrink
`ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS` so `outbox_free <
ITERATE_KIT_VOICE_MIC_OUTBOX_RESERVE` becomes reachable — the microphone-drop
path, currently unreachable on the host.

### 4.3 Mapping back to the four defect classes

| Defect class                                      | Knob that catches it                                           | Why it is unreachable today                                               |
| ------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `answer_done` latch (`79eb222b2`)                 | K1 (+K2b)                                                      | needs a reader that waits on an empty ring for many consecutive ticks     |
| concealment-debt word deletion (`a3416ed3a`)      | K1 + K2a/K2b                                                   | needs sustained `CONCEAL`, which needs the ring below prefill for seconds |
| `response.done` treated as barge-in (`e7d829ebe`) | K2b (`--downlink-gap-ms` reordering completion ahead of audio) | needs the small text event to overtake hundreds of audio events           |
| unsigned-time underflow (`64e061ab8`)             | K3                                                             | needs two clock samples in one iteration to disagree                      |

### 4.4 The sweep harness

- **One seed, and the commit.** `--fault-seed N` seeds a single small PRNG in
  `cli_options`; every fault decision derives from it. Record **seed + firmware
  commit** as the pair (TigerBeetle's contract) — and, because our bridge is
  deployed separately, the userspace worker's deploy identity too. Print it as
  a **paste-able command line**, from the parent process so a crashed child
  still surfaces it. One seed reproduces the fault **schedule**, not the run;
  say that in the report rather than implying more.
- **Swarm draw, not a matrix.** A 5-knob × 4-level matrix is 1024 runs ≈ 51 h at
  three minutes each; worse, per §2.4 the all-on cell suppresses the subtle
  bugs. Draw a random _subset_ of knobs (each independently off with p ≈ 0.5)
  at random intensities per run. **~100 seeded draws is 95% likely to cover any
  given choice of five knobs** — that is the whole budget argument. Keep ~8
  named "canon" configurations always in the rotation (`none`, `paced-sink`,
  `slow-link`, `clumped`, `jittered-clock`, `stalled-loop`, `lane-death`,
  `everything`); Groce et al. explicitly recommend keeping the everything-on
  config in every swarm set as insurance against a bad draw.
- **One lane stays exhaustive.** Anything enumerable should be enumerated, not
  sampled — SQLite, curl and Linux `fail-nth` all agree. If we add a set of
  named one-shot deviations, run `i = 1..N` and let the index be the
  reproduction handle; random sampling of a 15-element set is strictly worse
  than walking it.
- **Prefer fewer, longer soaks.** Klees et al. (§2.4) found rankings that
  _reverse with significance_ between 6 h and 24 h. The failures we care about
  — recycle ladders, liveness restarts, the `answer_done` latch — are
  cumulative. Spend at least half the budget on long runs and extract the short
  behaviour from them, not the reverse. Report medians over trials.
- **Where it lives.** An outer driver in `apps/kit/scripts/`, in the style of
  `voice-e2e.ts`: loop over seeds, run `iterate-kit-cli --converse N
--report-json ...`, assert on the report.
- **The oracle already exists.** `cli_main_pulse` emits the _same_ per-second
  line the device does (`batches/rx/gaps/played/conceal/under/ringMs`), and
  `cli_report` already records per-turn `failed`, occupancy histograms and
  underruns. Acceptance for a knob setting is "the CLI's pulse now looks like
  the device's pulse". Add three things:
  1. fault-schedule provenance in the report;
  2. **per-knob firing counts** — gofail's `/count`, FoundationDB's `TEST()`.
     Without them a green run and a run where the fault never triggered are
     indistinguishable. FDB's rule: if a condition's count is too low or zero,
     that is a defect in the _harness_, not evidence about the code;
  3. **"sometimes" assertions** over a whole sweep — e.g. _some_ run must
     observe `ready()` false for ≥ 10 consecutive ticks, and _some_ run must
     observe a `DROP_CATCHUP`. A sweep in which those never happen has not
     exercised what it claims to. This is the one idea every mature practitioner
     reinvented independently — FoundationDB's `CODE_PROBE` (the `TEST()` macro
     of the paper), Antithesis's `Sometimes` assertions, Resonate's "runs until
     every operation kind has produced at least one 2xx", and Dropbox's warning
     about a planner that deletes everything: _"No matter the input, we'd always
     end up with three identical empty trees, yet the test would still pass!"_
     Their sibling post puts it bluntly: _"a silly but common failure mode is a
     simulation test that does no work and trivially has no bugs."_
- **Two PRNG streams, not one.** FoundationDB splits `deterministicRandom()`
  from `debugRandom()` — _a parallel generator on the same seed_ — precisely so
  that adding a debug print does not consume a draw and shift every later
  decision. Without this, "add logging and re-run the seed" stops reproducing,
  which is the single thing a seed exists to buy. Dropbox reached the same
  conclusion from the other direction, listing "split the global PRNG into
  several independent ones" as the fix for their un-shrinkable seeds.
- **Audit your own determinism.** FoundationDB's _unseed_ is the cheapest
  possible check and we should copy it verbatim: at the end of a run, draw one
  more random number and print it. Its value is a function of how many draws the
  whole run consumed, so **same seed + different unseed ⇒ the fault schedule was
  not deterministic**. FDB reruns a random fraction of nightly runs this way and
  treats a mismatch as a test failure. Every other shop does the equivalent:
  Dropbox reruns each seed and asserts the same final state, Turso ships
  `--doublecheck`, S2 diffs TRACE logs byte-for-byte. Without it the harness
  silently rots.
- **Minimisation.** Replay the seed with each knob disabled in turn (five
  re-runs) to find the necessary set, then halve intensities. This is DEMi's
  first phase and it is enough. Do not build `ddmin`.

**The sibling harness has these bugs already, and they are worth fixing first
because they are cheap.** `apps/os/scripts/voicelab/` impairs the _bridge_ side
in TypeScript and makes exactly the two mistakes above:

- `impair.ts` seeds a `mulberry32` per lane (good), but `ImpairedLane` sets
  `startedAt = Date.now()` and computes the stall phase as
  `(now - startedAt) % stallEveryMs` with real `setTimeout`. The jitter _draws_
  are seed-reproducible; _which_ draw lands inside a stall window is wall-clock
  dependent. Same seed ≠ same impairment. Fix: derive the phase from a frame or
  event counter, not from `Date.now()`.
- `matrix.ts` hard-codes `seed=7` in **both** the `bad` and `awful` profiles, so
  the entire matrix samples a single realisation of the impairment space,
  repeated. Fix: vary the seed per run and record it.
- `reliability.ts` has no seed at all — every timing decision is `Date.now()`.

Same three fixes, same reasons, and they apply to the C sweep before it is
written.

### 4.5 What not to build

- **Not** a virtual clock / DST rewrite of `host_cli`. Its value is that it
  talks to the real bridge over real TLS. Determinism means a fake bridge,
  which is a _different, also-worth-having_ rig — the one already scoped in the
  07-31 prior-art doc. Keep them separate and say which lane a claim comes from.
- **Not** `DYLD_INTERPOSE` as the primary mechanism (§3: partial coverage, and
  it perturbs OpenSSL/CoreAudio).
- **Not** `dnctl`/`pfctl`/toxiproxy as the primary mechanism: root, host-wide
  state, and — decisively — they cannot express a delivery lane that dies while
  the socket stays open, which is a defect we have actually shipped. Keep
  toxiproxy for exactly one job: half-open sockets.
- **Not** failpoint macros inside `components/core/`.

---

## 5. What this will not catch — where the board is still the only authority

Stated plainly, because a green sweep will be tempting to over-read.

- **Anything acoustic.** ES8311/XMOS codec behaviour, AEC convergence and
  divergence, AGC, noise suppression, speaker distortion, room echo. The WAV
  sink is a witness of the _digital_ timeline. It cannot hear.
- **I2S/DMA truth.** Descriptor counts, the real blocking semantics of
  `i2s_channel_write`, the 90 ms hardware lead, underruns at the DMA boundary
  itself. K1 is a _model_ of the DAC. A model is not evidence about the DAC.
- **Memory.** DIRAM/IRAM/PSRAM budgets (the HAVPE landing records IRAM at
  16 383 of 16 384 bytes — one byte of headroom), heap fragmentation, per-task
  stack high-water, PSRAM bandwidth contention with the display.
- **Scheduling truth.** The host has one cooperative thread; the device has
  half a dozen preemptive tasks pinned across two cores, plus an unpinned lwIP
  task at priority 18. K4 models a stall; it cannot model a priority inversion,
  a starved task, or a watchdog.
- **Wi-Fi and radio.** Association loss, roaming, RSSI, the 17–19 s station-
  outage ladder recorded in `fable-esp32-station-outage-research-2026-07-31.md`,
  TCP behaviour over a lossy radio, TLS handshake under loss.
- **Power.** Brownout, rail sag under speaker load (the M5StickS3 `0x32=0xBF`
  finding), amplifier enable transients.
- **Toolchain and target.** Xtensa/RISC-V codegen, alignment faults, `-Os`
  differences, IRAM placement, cache behaviour, flash read latency.
- **Its own reflection.** Once the fault module exists, a defect _in the fault
  module_ looks exactly like a device defect. Discipline: any finding is
  re-run with the same seed and knobs off to confirm it is real, and then
  confirmed on the board before it is called a device defect.

The honest summary of the boundary: these knobs make the host binary
reproduce the _timing and ordering_ environment of the device. They do not
reproduce its _physics_, its _memory_, or its _scheduler_. Every one of the
four defect classes in the brief is a timing-and-ordering defect, which is why
this is worth building — and also why a green sweep proves nothing about the
categories above.

---

## Sources

Deterministic simulation:
FoundationDB paper <https://www.foundationdb.org/files/fdb-paper.pdf> ·
FDB testing/BUGGIFY <https://apple.github.io/foundationdb/testing.html> ·
<https://github.com/apple/foundationdb> ·
Will Wilson, Strange Loop 2014 <https://www.youtube.com/watch?v=4fFDFbi3toc> ·
TigerBeetle <https://github.com/tigerbeetle/tigerbeetle> ·
SimTigerBeetle <https://www.youtube.com/watch?v=Vch4BWUVzMM> ·
Antithesis <https://antithesis.com/docs/> ·
madsim <https://github.com/madsim-rs/madsim> ·
turmoil <https://github.com/tokio-rs/turmoil> ·
shuttle <https://github.com/awslabs/shuttle> ·
loom <https://github.com/tokio-rs/loom> ·
Hermit <https://github.com/facebookexperimental/hermit>

Fault injection:
FreeBSD `fail(9)` <https://man.freebsd.org/cgi/man.cgi?query=fail&sektion=9>
(**not** `fail_point(9)` — that query 404s), header
<https://github.com/freebsd/freebsd-src/blob/main/sys/sys/fail.h> ·
fail-rs <https://github.com/tikv/fail-rs> ·
gofail <https://github.com/etcd-io/gofail>, design/EBNF
<https://github.com/etcd-io/gofail/blob/master/doc/design.md> ·
libfiu <https://blitiri.com.ar/p/libfiu/> ·
SQLite testing <https://www.sqlite.org/testing.html> ·
curl runtests <https://curl.se/dev/runtests.html>, torture overview
<https://everything.curl.dev/internals/tests/torture.html> ·
Linux fault injection <https://www.kernel.org/doc/html/latest/fault-injection/fault-injection.html> ·
Toxiproxy <https://github.com/Shopify/toxiproxy> ·
libfaketime <https://github.com/wolfcw/libfaketime>

Real-time audio:
WebRTC <https://webrtc.googlesource.com/src/> (`api/test/simulated_network.h`,
`modules/audio_coding/neteq/tools/`, `test/time_controller/`) ·
GstHarness <https://gstreamer.freedesktop.org/documentation/check/gstharness.html> ·
Zephyr native_sim <https://docs.zephyrproject.org/latest/boards/native/native_sim/doc/index.html>

Search and minimisation:
Swarm testing, Groce/Zhang/Eide/Chen/Regehr ISSTA 2012
<https://agroce.github.io/issta12.pdf>, summary
<https://blog.regehr.org/archives/591> ·
Directed swarm testing, ISSTA 2016 <https://agroce.github.io/issta16.pdf> ·
FoundationDB `Buggify.h`
<https://github.com/apple/foundationdb/blob/main/flow/include/flow/Buggify.h> ·
TigerBeetle VOPR
<https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md>
and swarm weights
<https://tigerbeetle.com/blog/2025-04-23-swarm-testing-data-structures/> ·
DEMi, _Minimizing Faulty Executions of Distributed Systems_, NSDI '16
<https://www.usenix.org/system/files/conference/nsdi16/nsdi16-paper-scott.pdf> ·
Klees et al., _Evaluating Fuzz Testing_, CCS 2018
<https://arxiv.org/abs/1808.09700> ·
Wolff et al., _Greybox Fuzzing for Concurrency Testing_, ASPLOS 2024
<https://abhikrc.com/pdf/ASPLOS24.pdf> ·
PCT, Burckhardt et al., ASPLOS 2010
<https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/asplos277-pct.pdf> ·
Delta debugging, Zeller & Hildebrandt, IEEE TSE 2002
<http://www.st.cs.uni-saarland.de/papers/tse2002/tse2002.pdf>

Time bugs:
Cloudflare leap second
<https://blog.cloudflare.com/how-and-why-the-leap-second-affected-cloudflare-dns/>

In-repo:
`docs/waveshare-open-defect.md` ·
`docs/fable-esp32-offdevice-rig-prior-art-2026-07-31.md` ·
`firmware/tests/pcm_realtime_fault_harness_test.c` (the house pattern to
extend: a `struct rig` owning `now_ms`, an `enum rig_link_mode`, one scenario
function per named incident)
