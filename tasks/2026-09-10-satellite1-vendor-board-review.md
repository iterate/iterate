# Satellite1 vendor board and audio review

Reviewed 2026-09-10, read-only. This compares the original Satellite1 ESPHome board implementation with the current Iterate board path; it deliberately excludes the XMOS DSP-pipeline review.

## Sources inspected

| Source | Revision | Relevant material |
| --- | --- | --- |
| `FutureProofHomes/Satellite1-ESPHome` | `9814bf598976060a5a5b999448398877d15333e8` | board YAML, I2S speaker/microphone runtime, TAS2780 implementation |
| `FutureProofHomes/Satellite1-Hardware` | `2eb08ffaed8d9852d19b8acc86728d1af93d1c24` | `core/rev5.1coreSCH.pdf`, MCU sheet 3/6: GPIO16 is the `I2S_1_MCLK` net |
| Espressif ESP-IDF source present locally | `v5.5.3` | standard-mode MCLK routing semantics (`components/esp_driver_i2s`) |
| Iterate worktree | dirty at inspection (HEAD `7639193792d25767cb9c4d430dc543c06dd2dc77`) | Satellite1 facts and shared I2S board codec |

## Findings that are already adopted

### Continuous TX and a prefilled ring: adopted, and made stricter

The original speaker is 48 kHz, 32-bit stereo, has `timeout: never`, and uses the shared I2S bus ([vendor configuration](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/config/common/speaker.yaml#L30-L41)). Its task fills all DMA buffers with zeros on start, then writes zeros on every silent pass ([vendor runtime](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp#L308-L354), [continued](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp#L401-L449)). This is the board-specific behavior that keeps the XMOS AEC reference coherent; it should remain intact.

Iterate has the same 48 kHz / 32-bit / stereo slave format and pins BCLK 8, WS 7, DOUT 9 and DIN 15 (`apps/kit/firmware/devices/satellite1/satellite1_device.c:161-180`). It preloads every descriptor before channel enable (`platforms/iterate_esp_idf/components/board/i2s_codec.c:508-530`), primes the whole known ring at task start (`:250-288`), and continually sends a 20 ms silence frame while idle for an ungated amplifier (`:319-359`). No change.

### 48 kHz capture and 3:1 decimation: adopted

Vendor captures 32-bit stereo at 48 kHz on GPIO15 ([configuration](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/config/common/voice_assistant.yaml#L25-L34)), reads three times a 16 ms output chunk, and retains every third 32-bit sample ([runtime](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/satellite1/microphone/sat1_microphone.cpp#L217-L241)). Iterate uses a ratio of three in the Satellite1 capture shape and extracts the processed slot into its 16 kHz PCM contract (`satellite1_device.c:173-179`; `i2s_codec.c:599-624`). No change.

### Task priority and allocation discipline: adopted or improved

Vendor uses priority 19 for its speaker and 17 for its microphone ([speaker](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp#L16-L18), [microphone](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/satellite1/microphone/sat1_microphone.cpp#L16-L20)). Iterate pins the capture and playback hardware tasks to core 1 at priorities 19 and 20 (`i2s_codec.c:402-416`). Vendor allocates vectors and a scaling buffer during the [speaker](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp#L277-L290) and [microphone](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/satellite1/microphone/sat1_microphone.cpp#L221-L225) paths; Iterate uses fixed frames and depth-one mailboxes. Do not reintroduce the vendor lifecycle or allocation behavior.

### TAS2780 power-mode activation, mute, and supply checks: adopted

The donor holds the TAS2780 in shutdown at setup, then enters active-muted, waits 100 ms for SAR supply readings, selects a valid power mode, and only then becomes active ([TAS runtime](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/tas2780/tas2780.cpp#L269-L383)). It expressly waits until XMOS audio is ready before selecting DAC outputs ([routing configuration](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/config/common/speaker.yaml#L90-L124)). Iterate starts and preloads I2S before codec activation, then initializes the amp, applies the calibrated 60% ceiling, initializes PCM5122, activates TAS and unmutes PCM5122 (`satellite1_device.c:34-68`). Its TAS translation retains the 100 ms SAR wait, valid-supply selection and shutdown-on-failure (`platforms/iterate_esp_idf/components/board/codecs/tas2780.c:54-85`). No change.

### XMOS reset and control-bus facts: adopted

The vendor defines SPI2, mode 3, 8 MHz (GPIO12/11/13, CS GPIO10) and reset GPIO4 ([configuration](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/config/satellite1.base.yaml#L129-L135)); the hardware-reset action drives GPIO4 high for 100 ms then low for 100 ms ([runtime](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/satellite1/satellite1.cpp#L214-L219)). Iterate uses the same SPI pins/mode/open discipline and boots GPIO4 low before opening XMOS (`satellite1_device.c:41-48,157-160`). Do not add reset pulses to the audio fast path; they boot the XMOS flash mode. No change.

## Candidates, bounded by a proof requirement

### DC-offset removal after decimation: candidate, not yet justified

The vendor has an optional DC estimator: it subtracts an EMA (weight 1/1000) from each decimated capture sample ([definition](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/satellite1/microphone/sat1_microphone.cpp#L21-L23), [application](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/satellite1/microphone/sat1_microphone.cpp#L194-L240)). Current Iterate capture has no comparable subtraction (`i2s_codec.c:599-624`).

This could improve an offset-biased physical microphone but is not evidence of an existing fault. Before adding it, collect at least a 60-second idle capture and a repeated barge-in run with the exact current gain/slot. Add it only if the mean bias is material and the change preserves the present zero-self-barge result while improving (or not worsening) speech-end to first actual board audio. This is a candidate, not a recommendation to change the live baseline.

### Descriptor-send timestamps: diagnostic candidate only

Vendor queues its `on_sent` ISR timestamps and turns them into its audio-output callback ([callback consumption](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp#L431-L445), [ISR](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp#L548-L565)). Iterate records I2S overflow/health fields but has no descriptor-send timestamp in the board metric path (`i2s_codec.c:736-759`). A bounded ISR-safe timestamp or timestamp histogram could distinguish "queued" from actual DMA delivery in the speech-end-to-board-audio metric. It does not reduce latency itself, so only add it if the team needs this missing observability to choose between remaining latency hypotheses.

### One-second post-XMOS connection settle: boot-reliability experiment only

Original ESPHome keeps `xmos_audio_ready` false, waits one second after the SPI version probe, then releases audio routing ([configuration](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/config/satellite1.base.yaml#L152-L176)). Iterate bounds its version-open retry and begins chip bring-up after that open (`satellite1_device.c:38-60`). The vendor delay may be ordinary Home Assistant or flashing orchestration, rather than a board electrical requirement. Do not put a speculative one-second delay in the first-answer path. If cold boots show an amp/SAR/I2S startup failure, test a boot-only settle gate while tracking the existing amp/I2C/queue health counters.

### Smaller physical DMA ring: controlled latency candidate

The vendor I2S component defaults to four 240-frame descriptors, a 20 ms physical ring at 48 kHz ([defaults](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/i2s_audio.h#L161-L164)). Current Satellite1 uses 480 x 6, a 60 ms ring (`satellite1_device.c:173-180`). The smaller donor ring is not proof of an optimal setting, but ring depth can contribute directly to speech-end-to-first-board-audio delay.

Test one smaller descriptor configuration at a time while retaining continuous TX, initial prefill, and idle zero fill. Accept only a reproducible improvement to the primary metric with no playback/capture queue overflows, no increased driver failures or starvation, and no regression from the current zero-self-barge result. This is a latency experiment, not a reason to adopt the donor default wholesale.

## Incompatible or explicitly rejected donor behavior

### GPIO16 MCLK is not an external-clock trick to copy

The donor declares GPIO16 as `i2s_mclk_pin` despite using `secondary` (slave) mode ([configuration](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/config/common/core_board.yaml#L55-L61)). Its component schema requires that field to be an output-capable GPIO ([schema](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/__init__.py#L228-L231)), its I2S code passes it directly to `i2s_std_gpio_config_t` ([runtime](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/i2s_audio.cpp#L84-L94)), and the generated standard clock configuration uses `I2S_CLK_SRC_DEFAULT` rather than external ([clock setup](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/i2s_audio.h#L48-L57)).

This matters: ESP-IDF routes a non-external configured MCLK pin to `mck_out_sig`; it routes the pin to `mck_in_sig` only when `I2S_CLK_SRC_EXTERNAL` is selected ([routing implementation](https://github.com/espressif/esp-idf/blob/v5.5.3/components/esp_driver_i2s/i2s_common.c#L960-L984); [API contract](https://github.com/espressif/esp-idf/blob/v5.5.3/components/esp_driver_i2s/include/driver/i2s_std.h#L254-L270)). The donor's configuration is therefore an ESP-driven MCLK output, not evidence that the ESP should consume XMOS MCLK. The [Satellite1 core schematic](https://github.com/FutureProofHomes/Satellite1-Hardware/blob/2eb08ffaed8d9852d19b8acc86728d1af93d1c24/core/rev5.1coreSCH.pdf) confirms the physical GPIO16-to-`I2S_1_MCLK` net (MCU sheet 3/6).

Current Iterate leaves MCLK unused while treating the XMOS as the clock owner (`satellite1_device.c:159-171`; validation in `board.c:57-61`). Copying the vendor's default MCLK-output configuration could electrically contend with an XMOS-driven net. Explicitly configuring an external MCLK input would avoid that electrical contention, but it would be a different, unproven clock-reference design rather than an adoption of the donor behavior. Do not change either form without an on-board scope measurement that establishes net direction and frequency for the deployed XMOS build, then a one-variable full-duplex/AEC/latency experiment.

### Dynamic I2S start/stop: do not adopt

The donor starts/stops its microphone and I2S driver according to active listeners ([microphone lifecycle](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/satellite1/microphone/sat1_microphone.cpp#L61-L170)) and lets speaker state stop the I2S channel ([speaker lifecycle](https://github.com/FutureProofHomes/Satellite1-ESPHome/blob/9814bf598976060a5a5b999448398877d15333e8/esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp#L465-L498)). That breaks the current Satellite1 requirement that the XMOS always receive its TX/AEC reference. Keep continuous I2S/TX; ring-size changes remain the separately bounded latency experiment above.

## Conclusion

The original firmware's high-value board behavior is already in the Iterate implementation: continuous zero-filled TX, complete DMA prefill, 48 kHz 32-bit stereo slave I2S, 3:1 capture decimation, TAS SAR-gated power-mode selection, and the GPIO4/SPI control facts. The controlled candidates are DC removal, descriptor timestamps, and a smaller DMA ring. The apparent GPIO16 MCLK difference is a trap: primary-source inspection shows the donor config drives it as an ESP MCLK output; external input is a separate unproven design, not the donor configuration.
