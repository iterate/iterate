#include "iterate/kit/platforms/aic3204.h"

/*
 * NS remains the unqualified production default. A release experiment may
 * select another cumulative XMOS tap in a separate build directory, but the
 * choice must be a compiler-visible build input: editing this source between
 * flashes made retained evidence impossible to attribute and made accidental
 * production drift too easy. The numeric values are the XMOS wire contract
 * mirrored by the public enum below, so reject an out-of-range cache value at
 * compile time rather than sending an invented command to hardware.
 */
/*
 * NS (3), AND THE DRIFT TO 1 IS A CAUTIONARY TALE. The long comment below
 * argues honestly for the AEC tap from bench windows — and a real
 * conversation falsified it TWICE: first the production run it records
 * ("the first short reply leaked through the AEC tap nearly unchanged"),
 * and then again live on 2026-08-19, when a stage-1 build reached a
 * physical board mid-conversation and the board's own oracle read
 * echoRawPeak 8509 against echoCleanPeak 8514 — the "cancelled" uplink as
 * loud as the raw microphone, and the listener heard nothing but double
 * talk. The hardware-config test pins THIS number; the day it goes red
 * against this file, the test is the side that is right.
 */
#ifndef ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE
#define ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE 3
#endif

#if ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE < 0 || \
    ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE >= 5
#error "ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE must be an XMOS pipeline stage 0..4"
#endif

/*
 * Do not "simplify" this table from the data sheet in isolation. It mirrors
 * ESPHome's proven AIC3204 setup, including page switches, 32-bit I2S, MFP3
 * routing, 0.75 V common mode, analogue driver routing, and pop-suppression
 * settings for the actual Voice Preview Edition circuit. The host literal
 * test makes any divergence an intentional hardware change with reviewable
 * evidence rather than an unexplained acoustic regression.
 */
static const struct iterate_kit_register_write initial_writes[] = {
  {0x00, 0x00}, {0x01, 0x01}, {0x0b, 0x82}, {0x0c, 0x82},
  {0x0e, 0x80}, {0x1b, 0x30}, {0x38, 0x02}, {0x1f, 0x01},
  {0x20, 0x01}, {0x3c, 0x01}, {0x00, 0x01}, {0x02, 0x09},
  {0x01, 0x08}, {0x02, 0x01}, {0x0a, 0x40}, {0x03, 0x00},
  {0x04, 0x00}, {0x7b, 0x01}, {0x14, 0x25}, {0x0c, 0x08},
  {0x0d, 0x08}, {0x0e, 0x08}, {0x0f, 0x08}, {0x10, 0x3e},
  {0x11, 0x3e}, {0x12, 0x00}, {0x13, 0x00}, {0x09, 0x3c},
};

/*
 * Keep the DAC at 0 dB even though ESPHome's theoretical 100% endpoint is
 * +24 dB. A production full-duplex run at that endpoint transcribed
 * its own speaker output almost verbatim on XMOS's processed channel: the
 * positive digital gain exhausted acoustic/AEC headroom before the DSP could
 * provide useful cancellation. PCM reaches this boundary unscaled, so 0 dB is
 * the loudest setting that cannot electrically clip a full-scale provider
 * sample. If the nearby-Mac oracle later proves it too quiet, volume may move
 * only behind a measured unclipped/AEC gate; intelligibility is not permission
 * to reintroduce self-triggering server VAD.
 */
static const struct iterate_kit_register_write power_up_writes[] = {
  {0x00, 0x00},
  {0x3f, 0xd4},
  {0x41, 0x00},
  {0x42, 0x00},
  {0x40, 0x00},
};

const struct iterate_kit_register_script iterate_kit_aic3204_scripts[2] = {
  {
    .i2c_address = 0x18,
    .writes = initial_writes,
    .count = sizeof(initial_writes) / sizeof(initial_writes[0]),
    .settle_ms = 2500,
    .when = ITERATE_KIT_SCRIPT_BEFORE_I2S,
  },
  {
    .i2c_address = 0x18,
    .writes = power_up_writes,
    .count = sizeof(power_up_writes) / sizeof(power_up_writes[0]),
    .settle_ms = 0,
    .when = ITERATE_KIT_SCRIPT_AFTER_I2S,
  },
};

enum iterate_kit_xmos_stage
iterate_kit_xmos_uplink_stage(void) {
  /* XMOS exposes cumulative AEC -> IC -> NS -> AGC taps. The HAVPE bench
   * selects NS (tap 3) with the fixed capture gain in its board table: long
   * answers measured about 25 dB raw/clean separation on 2026-09-09. Tap 1
   * leaked at answer onset; tap 4 expanded residual echo and retriggered VAD.
   * Keep the TX reference running between answers and measure provider turns
   * plus echoRawPeak/echoCleanPeak when changing this choice. aec.setStage
   * selects a tap live. Speaker-time gain changes or uplink gating would
   * invalidate that comparison and can erase a person's interruption.
   */
  return (enum iterate_kit_xmos_stage)
      ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE;
}
