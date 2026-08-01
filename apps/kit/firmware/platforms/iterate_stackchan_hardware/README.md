# StackChan hardware policy adapter

This directory translates the generic screen, LED, servo, and camera contracts
into a small set of injected physical-I/O operations. It owns policy and
bounded state; it deliberately does not own an ESP-IDF task, network client,
image decoder, or hardware-global singleton.

The split matters because display, PY32 I2C, servo UART, and camera operations
must eventually be scheduled around realtime audio. A target can route the
injected calls through its chosen hardware owner, while the same adapter runs
unchanged in the host rig with failure-injecting fakes.

## What is proved here

- screen colours use RGB888 and remote images require HTTPS;
- all 12 body LEDs are sent as one RGB565 transaction, with a 24-byte shadow
  committed only after successful I/O;
- relative yaw is mapped to the official 150-degree StackChan centre, while
  the documented mechanical limits remain enforced at the local C boundary;
- camera bytes are never copied or queued: exactly one encoded frame may be
  borrowed, and it must be released before another capture;
- missing physical operations return `UNAVAILABLE` instead of simulating
  success; and
- the adapter remains allocation-free and at most 128 bytes on the 64-bit host
  ABI (currently 96 bytes; the ESP32-S3 ABI uses smaller pointers).

Run the isolated host tests with:

```sh
cmake -S apps/kit/firmware/platforms/iterate_stackchan_hardware \
  -B /tmp/iterate-stackchan-hardware-build
cmake --build /tmp/iterate-stackchan-hardware-build
ctest --test-dir /tmp/iterate-stackchan-hardware-build --output-on-failure
```

## Honest target status

This component is not yet added to a device target. The injected physical
operations are therefore tested policy boundaries, not a claim that current
firmware drives the attached StackChan.

The exact target-side mechanisms found in M5Stack's StackChan/CoreS3 sources
are:

- display: `bsp_display_start()`, then `bsp_display_lock()` / LVGL /
  `bsp_display_unlock()`;
- body LEDs: the PY32 at I2C address `0x6f`, with 12 RGB565 words beginning at
  register `0x30` and the refresh bit in register `0x24`;
- servos: SCS0009 IDs 1 and 2 over 1 Mbaud UART on CoreS3 pins TX 6 / RX 7,
  using the Feetech sync-write instruction; and
- camera: CoreS3's GC0308 through `esp_camera_fb_get()` /
  `esp_camera_fb_return()`.

Three gaps must remain explicit:

1. The GC0308/BSP produces RGB565 rather than JPEG. Existing M5Stack helpers
   allocate while encoding, so `takePhoto()` needs a bounded encoder/output
   store before a real backend can satisfy the encoded-image contract.
2. `renderOnScreen(url)` still needs a bounded HTTPS fetch plus PNG decoder.
   The adapter rejects cleartext and returns `UNAVAILABLE` until one is
   injected.
3. Target assembly must initialize and inject the display/I2C/UART operations.
   That wiring belongs with the chosen device profile so it cannot steal work
   from the realtime audio owner accidentally.
