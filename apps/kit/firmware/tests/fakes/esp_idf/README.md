# The platform half of a voice loop test

`components/voice/src/voice_loop.c` is the one program every board runs. Its
intent mapping — the thing that decides whether a press becomes a call — is
where a remote press once latched and was never read, and reading the code did
not find it. So the loop is compiled on a laptop and driven by tests.

The loop is ESP-IDF-coupled by design: it owns FreeRTOS tasks, queues, the task
watchdog and the platform transport, because those are the parts a device
actually is. Two things stand in for the ESP32 on a host, and they live in two
places.

## The host ESP-IDF lives in `platforms/host`

`platforms/host/esp_idf/` (library `iterate-kit-host-esp-idf`, entry point
`esp_idf.h`) is the ESP-IDF the loop names — `esp_timer`, `esp_log`,
`esp_random`, FreeRTOS tasks and queues, the task watchdog — on a laptop. It is
real where a running program needs it: a monotonic clock, delays that sleep,
randomness, logging to stderr. It is deliberately not scheduling:
`xTaskCreatePinnedToCore` records the task and returns `pdPASS` without running
it, and a queue is a bounded ring that never waits. Whoever owns the process
pumps `iterate_kit_voice_loop_step`, `_capture_step` and `_playback_step`
itself, on one thread. `targets/mac` does that to be a device; a test does it
to be a test. That is the reason those three entry points exist.

A test pins the clock with `iterate_kit_host_esp_idf_set_now_us()`. From then
on time moves only through set, `iterate_kit_host_esp_idf_advance_ms()` and the
delays the loop itself takes (`vTaskDelay` is a clock move, a queue timeout is
spent only when it is actually waited out), and a restart is recorded, not
honoured: `iterate_kit_host_esp_idf_restart_requested()` reads what
`esp_restart()` recorded. Unpinned, `esp_restart()` prints the note
and exits. Logging is quiet under a pinned clock unless `ITERATE_KIT_ESP_LOG`
says otherwise. Every fixture calls `iterate_kit_host_esp_idf_reset()` first,
because all of it is file-static, exactly like the firmware it stands in for.

## What is here: a scriptable transport and a provisioned board

`fake_esp_idf_platform.{c,h}` is library `iterate-kit-esp-idf-fakes`, defined
in `tests/CMakeLists.txt` and compiled against
`platforms/iterate_esp_idf/include`, because the loop it links
(`iterate-kit-voice`) is the ESP-shaped one. It implements the five platform
headers the loop calls — provisioning, reset reason, restart note, system update
and the itx transport — so every struct has its real layout and every call its
real signature. Only the behaviour is pretend.

Provisioning answers with a provisioned board (`prj_fake`, `itxk_fake`),
because an unprovisioned one returns from init before anything else in the loop
runs and every test would be about that. The reset reason is `"fake"`. A
restart note is recorded and handed to `esp_restart()`. `system.update` is
accepted and not downloaded, so the capability mounts.

The transport fake is the way a test gets a message INTO the device. It
receives `options.connection` in `prepare()` exactly as the real transport does,
so `iterate_kit_fake_platform_connection()` hands a test the same session the
socket would feed. A remote press is therefore the bytes a caller sends, not a
hook: no accessor had to be added to `loop.h` for any of this.
`iterate_kit_fake_platform_connect()` brings the pretend socket up when the
test says so, never on a timer; `_set_state()` is what the loop reads as the
transport's lifecycle. Everything the loop sent is reassembled into whole
Cap'n Web messages (`_sent_count()`, `_sent()`, `_find_sent()`), and a test can
fail the next send, fill or drain the control outbox, and count the restarts the
loop asked the transport for. `iterate_kit_fake_platform_reset()` comes first in
every fixture, beside the host ESP-IDF's.

## The rule

If a test needs a behaviour these fakes do not have, add the behaviour here (or
in `platforms/host/esp_idf` if it is an ESP-IDF primitive) rather than reaching
around them. A test that bypasses the fake is testing the test.
