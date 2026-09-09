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
 * +24 dB. A production full-duplex run at that endpoint made Grok transcribe
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

const struct iterate_kit_register_script *iterate_kit_aic3204_initial_script(void) {
  static const struct iterate_kit_register_script script = {
    .i2c_address = 0x18,
    .writes = initial_writes,
    .count = sizeof(initial_writes) / sizeof(initial_writes[0]),
    .settle_ms = 2500,
    .when = ITERATE_KIT_SCRIPT_BEFORE_I2S,
  };
  return &script;
}

const struct iterate_kit_register_script *iterate_kit_aic3204_power_up_script(void) {
  static const struct iterate_kit_register_script script = {
    .i2c_address = 0x18,
    .writes = power_up_writes,
    .count = sizeof(power_up_writes) / sizeof(power_up_writes[0]),
    .settle_ms = 0,
    .when = ITERATE_KIT_SCRIPT_AFTER_I2S,
  };
  return &script;
}

enum iterate_kit_xmos_stage
iterate_kit_xmos_uplink_stage(void) {
  /*
   * AEC, WITH A FIXED GAIN AFTER IT — because the choice between the taps is a
   * choice between two ways of being wrong, and only one of them is fixable
   * with a constant.
   *
   * Measured against the real provider, two turns each, question asked out
   * loud into the room (`voicelab aec --real --stages N`):
   *
   *   tap 4 AGC : room floor -39 dBFS, echo +22 dB over it. x.ai HEARD ITSELF
   *               and cancelled its own answer 5.6 s into a count to forty.
   *   tap 3 NS  : room floor -110 dBFS, echo +25 dB over it.
   *   tap 1 AEC : room floor  -83 dBFS, echo +1.0 dB over it — the echo sits
   *               AT the room floor, and whisper hears nothing of the answer.
   *
   * So the canceller works and the AGC undoes it. An automatic gain has to
   * raise quiet passages to hit its target, and between the assistant's words
   * the only thing there IS to raise is the residue; the ratio that separates
   * a person from an echo is exactly what it spends. The device then reports
   * its own voice to a detector that cannot know better, and the answer stops
   * mid-word.
   *
   * A FIXED gain cannot do that. It moves the person and the residue by the
   * same number of decibels, so the 30-odd dB between them at tap 1 survives
   * intact; all it changes is that both land somewhere a provider's detector
   * can see. That is the whole reason the constant below is a constant and
   * must never become adaptive, ducked, or gated — every previous attempt to
   * make it clever is what deleted the customer.
   *
   * The vendor ships tap 4 because it ships with wake-word-then-listen, where
   * the microphone is not open while the speaker runs and the AGC never has to
   * choose. Open-mic full duplex is a different problem and needs the tap
   * underneath.
   *
   * XMOS exposes cumulative taps in the order AEC -> IC -> NS -> AGC, and the
   * shipping Home Assistant Voice PE configuration selects AGC on channel 0
   * and NS on channel 1 (esphome/components/voice_kit/__init__.py:86-90). It
   * then feeds channel 0 to the assistant with `noise_suppression_level: 0`,
   * `auto_gain: 0 dbfs`, `volume_multiplier: 1` (home-assistant-voice.yaml
   * :1804-1807) — no host-side processing of any kind, because the tap is
   * already the finished thing.
   *
   * The AGC stage is not a loudness knob bolted on the end. It is the only
   * stage that receives the AEC's own opinion of the frame
   * (modules/audio_pipelines/reference/fixed_delay/audio_pipeline_t0.c
   * :124-131): `aec_ref_power` says how loud the far end is, `aec_corr_factor`
   * says how much of what the microphone hears correlates with it, and
   * `vnr_flag` says whether a voice is present at all. `AGC_PROFILE_ASR` uses
   * those three to hold gain down while the residue is ours and let it up
   * while a person is talking. That is echo-aware level control, tuned against
   * this microphone array by the people who built it.
   *
   * Stopping at NS discards it, and this device then reimplemented it badly in
   * userspace three times over: a fixed x16 make-up gain standing in for the
   * level target, a duck to x1 during playback standing in for loss control,
   * and an absolute barge-in floor with a memset standing in for the
   * correlation test. Each of the three has a comment explaining why it is
   * needed; each is needed only by the one before it; none of them can see
   * `aec_corr_factor`, so none can tell echo from a person except by loudness,
   * and by loudness a person two feet away loses. All three are deleted.
   *
   * The previous note here recorded a production run in which AGC "expanded
   * quiet speaker residue by roughly two orders of magnitude and retriggered
   * server VAD". That run had the x16 make-up gain downstream of it, so the
   * measured expansion is at least partly ours, and it read the tap through a
   * gate that was deleting frames. The experiment is not evidence about AGC
   * and is not treated as any; the board's own raw/cancelled oracle decides.
   *
   * The corrected IC experiment held the control and double-talk captures
   * on the same path, supplied adequate spoken SNR, and kept transport and
   * network valid; it still reached only 0.888 similarity and -7.50 dB
   * residual. A corrected NS run measured two matched-path Mac-only captures at
   * 0.982 similarity / -15.46 dB residual. During double-talk it retained 0.901
   * similarity / -8.69 dB and Grok transcribed the intended nearby utterance
   * exactly. That is bounded damage, not erased near speech.
   *
   * The tempting alternative was the upstream AEC tap: its long, pre-warmed
   * physical matrix looked excellent (0.909 double-talk similarity and about
   * -47 dB far residue). A fresh production-shaped run falsified that choice.
   * The first short reply leaked through the AEC tap nearly unchanged, server
   * VAD opened a second turn, and Grok transcribed its own exact words, "How can
   * I help?". The first measured playback windows also showed raw and processed
   * peaks of the same order, identifying an onset/convergence problem that the
   * settled matrix could not expose. Both of those runs measured a tap with
   * no loss control in front of a userspace gain that had none either, which
   * is the arrangement being removed; they are kept because the AEC-tap
   * onset/convergence observation is still a real thing to watch for, not
   * because either verdict still selects a stage.
   *
   * This is deliberately guarded by the physical oracle rather than assumed
   * from the tap name. `aec.setStage` moves this tap at runtime, so the
   * comparison is a measurement and not a rebuild: `voicelab aec --stages`
   * walks 1/2/3/4 through the same four windows and reads raw-versus-cancelled
   * off the board at each. Reject AGC here if it erases or materially changes
   * nearby speech, or if far-only leakage opens any provider turn. What must
   * NOT come back if it disappoints is the userspace replacement — a fixed
   * make-up gain, a speaker-time duck, or a floor that deletes frames. Those
   * are the three pieces of the stage this line selects, rebuilt blind.
   */
  return (enum iterate_kit_xmos_stage)
      ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE;
}

/*
 * Percent to the AIC3204's two DAC channel-gain registers (0x41, 0x42), in
 * half-decibel steps on page 0.
 *
 * 100 IS 0 dB, NOT THE CHIP'S +24 dB CEILING. Positive digital gain here made
 * the provider transcribe this device's own speaker output almost verbatim on
 * the XMOS processed channel — the gain exhausted acoustic and AEC headroom
 * before the DSP could cancel anything. 0 dB is also the loudest setting that
 * cannot electrically clip a full-scale provider sample, and PCM reaches this
 * boundary unscaled. So the knob spans silence to 0 dB, which is the whole of
 * the safe range; anything above it is a different measurement, not a setting.
 *
 * The scale is in dB rather than linear percent because the ear is: halfway
 * along this control is -31.5 dB, which is quiet but not inaudible.
 */
uint8_t iterate_kit_aic3204_volume_register(uint8_t percent) {
  if (percent > 100U) percent = 100U;
  enum { MINIMUM_HALF_DB = -126 }; /* -63 dB, the register floor */
  const int8_t half_db = percent == 0U
      ? (int8_t)MINIMUM_HALF_DB
      : (int8_t)(MINIMUM_HALF_DB + ((int)-MINIMUM_HALF_DB * (int)percent) / 100);
  return (uint8_t)half_db;
}

#ifdef ESP_PLATFORM
esp_err_t iterate_kit_aic3204_write_script(
    i2c_master_dev_handle_t device, const struct iterate_kit_register_script *script) {
  if (script == NULL || script->writes == NULL || script->count == 0U) return ESP_ERR_INVALID_ARG;
  for (size_t index = 0U; index < script->count; ++index) {
    const uint8_t command[] = {script->writes[index].address, script->writes[index].value};
    const esp_err_t status = i2c_master_transmit(device, command, sizeof(command), 50);
    if (status != ESP_OK) return status;
  }
  return ESP_OK;
}

esp_err_t iterate_kit_aic3204_set_volume(i2c_master_dev_handle_t device, uint8_t percent) {
  const uint8_t code = iterate_kit_aic3204_volume_register(percent);
  const struct iterate_kit_register_write writes[] = {
    {0x00U, 0x00U}, {0x41U, code}, {0x42U, code},
  };
  const struct iterate_kit_register_script script = {
    .i2c_address = 0x18,
    .writes = writes,
    .count = sizeof(writes) / sizeof(writes[0]),
    .settle_ms = 0,
    .when = ITERATE_KIT_SCRIPT_AFTER_I2S,
  };
  return iterate_kit_aic3204_write_script(device, &script);
}
#endif
