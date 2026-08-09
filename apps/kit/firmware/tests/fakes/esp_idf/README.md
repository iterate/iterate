# A pretend ESP-IDF, so the shared voice loop can be tested at all

`components/voice/src/voice_loop.c` is the one program every board runs, and
until now it was in no host build. Its intent mapping — the thing that decides
whether a press becomes a call — was verified only by diffing it against the
four device files it replaced, and the bug that cost an afternoon (a remote
press latched and never read) lived exactly there.

The loop is ESP-IDF-coupled by design: it owns FreeRTOS tasks, queues, the task
watchdog and the platform transport, because those are the parts a device
actually is. So the way to test it on a laptop is to give it an ESP-IDF that is
not one.

## What these headers are, and what they are not

They are the **narrowest possible** stand-ins for the ESP-IDF and platform
surface `voice_loop.c` names — nothing else in this repository includes them,
and the real build never sees them. Each is on the include path only for the
host `iterate-kit-voice` target.

They are **not an emulator**. The queue fake is a real bounded ring, because the
loop's audio paths would be meaningless without one; everything else is a
recorded no-op that returns the success the loop needs to get past boot. Nothing
here schedules: `xTaskCreatePinnedToCore` records the task and returns `pdPASS`
without running it, so a host test drives `iterate_kit_voice_loop_step`,
`_capture_step` and `_playback_step` itself, one thread, in whatever order the
test is about. That is the reason those three entry points exist.

`fake_esp_idf.h` exposes the handful of observations a test needs — how many
tasks were created, whether the device asked to restart — plus
`iterate_kit_fake_esp_idf_reset()`, which every fixture must call because all of
this is file-static, exactly like the firmware it stands in for.

## The platform half

`fake_esp_idf_platform.c` stands in for the four platform modules the loop
calls — provisioning, reset reason, restart note, and the itx transport — and
it implements the **real** headers, so every struct has its real layout and
every call its real signature.

The transport fake is also the way a test gets a message INTO the device. It
receives `options.connection` in `prepare()` exactly as the real transport does,
so `iterate_kit_fake_platform_connection()` hands a test the same session the
socket would feed. A remote call is therefore the bytes a caller sends, not a
hook: no accessor had to be added to `loop.h` for any of this.

It also owns the hop. `iterate_kit_fake_platform_set_hop_answers(false)` is a
half-open socket — TCP accepting everything and nothing coming back — which is
the failure the press probe exists for and cannot otherwise be reproduced.

## The rule

If a test needs a behaviour these fakes do not have, add the behaviour here
rather than reaching around them. A test that bypasses the seam is testing the
test.
