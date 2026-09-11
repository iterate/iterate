# Iterate Kit firmware

Every board and the Mac CLI use GPT-Live-1 through the same voice stream.
The device owns capture, playback, controls, and its hardware capabilities.
The backend owns the OpenAI session, continuous input clock, and agent behavior.

## Ownership

| Code               | Owns                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `components/core`  | Cap’n Web, PCM framing, microphone flush timing, playout and control state |
| `components/audio` | PCM conversion, AEC processing, capture and starvation accounting          |
| `components/voice` | ESP application loop and capture/playback task coordination                |
| `platforms`        | ESP-IDF and macOS hardware, networking, and task ownership                 |
| `devices/<board>`  | Pins, codecs, DMA, physical controls, display and board-specific DSP       |
| `targets/<board>`  | Build composition, chip/flash geometry and SDK defaults                    |

Microphone batching is `microphone_flush.h`: first batch immediately, subsequent
partial batches within 50 ms, at most eight 20 ms frames per append. Both clients
retain native queues; neither needs a second uploader state machine.

A press or wake must open capture before connection progress. Preserve opening
speech while mounting, and drain it as soon as the stream can accept it without
waiting for call acceptance. Release drains the captured tail. Cancel and mute
discard that activation’s queued speech and fence late callbacks. Buffer limits
are measured in PCM duration, with an explicit failure on overflow.

`voice_playout.c` supplies one playback step for both clients. The board owns
its DMA/reference clock; the Mac owns its CoreAudio pull and render tap. Keep
these physical timing differences at their hardware implementations.

The two transports remain platform-specific: ESP splits network and application
work across tasks; the CLI has one owner. Changes to socket generations, mount
recovery or message ordering must be verified on both.

Face animation stays in reduced processor runtime state. The C client polls
`getProcessorRuntimeState` only while answer audio needs facial updates; it does
not subscribe to the browser LiveState delta protocol.

## Add an ESP32 board

Start with `devices/satellite1/satellite1_device.c` for the table shape, or the
closest supported codec. A normal addition has four small files:

1. `devices/<board>/<board>_device.c`: hardware table and `app_main()`.
2. `devices/<board>/CMakeLists.txt`: that source and its direct dependencies.
3. `targets/<board>/CMakeLists.txt`: shared components plus the device.
4. `targets/<board>/sdkconfig.defaults`: chip, flash, PSRAM and wake-model facts.

Reuse the existing I2S codec, volume, button, LED and face code. Add an `extra`
callback only for real hardware work such as a display BSP, servo or a shared
mic/speaker clock. A new board must not add a model choice, wire dialect, voice
loop branch or another capture/playback pipeline.

Confirm pins, I2S slots/rates, amplifier polarity and AEC ownership from vendor
source. HAVPE and Satellite1 use XMOS. M5StickS3 and Waveshare retain their local
capture/playback constraints. A board name alone is not evidence of working AEC.

See the [device onboarding skill](../../../.agents/skills/adding-a-kit-device-or-sprite/SKILL.md)
for codec examples, managed dependency pins, sprites and bench verification.
Installer publication separately adds the built binaries and hashes to
`apps/kit/src/firmware/catalog.ts`.

## Verify

From `apps/kit`, run `pnpm firmware:test:host`. The ignored host build is
`firmware/.build/host`. Tests use fakes or file/memory audio sinks.

Build each ESP target from its own directory. Use a fresh configuration when
changing defaults so a stale generated file cannot conceal the change:

```bash
idf.py -B /tmp/kit-havpe-build -D SDKCONFIG=/tmp/kit-havpe.sdkconfig build
```

For silent HAVPE diagnostics, compile with
`CONFIG_ITERATE_KIT_DIAGNOSTIC_SILENT_OUTPUT=y`. This holds its amplifier disabled,
suppresses local sounds, and writes only zero PCM while preserving XMOS clocks.
It proves digital capture/transport behavior; acoustic wake, AEC and audible
playout require a separate physical measurement.
