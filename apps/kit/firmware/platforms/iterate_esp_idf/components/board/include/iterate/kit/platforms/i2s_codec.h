#ifndef ITERATE_KIT_PLATFORMS_I2S_CODEC_H
#define ITERATE_KIT_PLATFORMS_I2S_CODEC_H

#include "iterate/kit/audio_codec.h"
#include "iterate/kit/pcm_format.h"
#include "driver/i2s_std.h"
#include "iterate/kit/voice_playout.h"

#ifdef __cplusplus
extern "C" {
#endif

/** I2S pins, wire formats and DMA geometry, using IDF's configuration types.
 * Equal ports mean ONE duplex pair with matching clocks/pins. Separate ports
 * have independent clocks and capture_dma_* (HAVPE: TX 480x6, RX 320x5).
 * The slave policy retains HAVPE's priority-3 interrupt and clear-after TX;
 * the master policy retains M5's priority-2 interrupt and clear-before TX.
 * Neither permits power-down. capture_gain is a fixed, saturating multiplier,
 * never a speaker-dependent duck or gate: that would also delete barge-in.
 * amplifier_gpio -1 means board-owned; gated rails follow ARRIVED/QUIET,
 * otherwise raised once after enable and codec power-up, before tasks start.
 */
struct iterate_kit_i2s_codec_facts {
  i2s_port_t playback_port;
  i2s_port_t capture_port;
  i2s_role_t role;
  i2s_std_config_t playback;
  i2s_std_config_t capture;
  uint16_t dma_frames;
  uint8_t dma_descriptors;
  struct iterate_kit_pcm_shape playback_shape;
  struct iterate_kit_pcm_shape capture_shape;
  uint8_t capture_gain;
  int8_t amplifier_gpio;
  bool amplifier_gated;
  uint16_t amplifier_settle_ms;
  uint16_t capture_dma_frames;
  uint8_t capture_dma_descriptors;
};

/** Validate and open the table, preload the complete TX ring with silence,
 * enable both channels. finish starts the shape-converter tasks after the
 * board has configured its codec. Invalid byte
 * geometry (>4092/descriptor), rate/ratio, or conflicting pins fails before
 * hardware allocation. Failures return false; the board loop must park with
 * its fault, never return past an enrolled watchdog. Start once per boot.
 */
bool iterate_kit_i2s_codec_start(
    const struct iterate_kit_i2s_codec_facts *facts,
    struct iterate_kit_audio_codec *out);
/** Open/init/preload only TX using the same table policy, leaving it disabled.
 * M5 keeps delete/rebuild board-local: after this call it configures ES8311
 * while muted, enables, and eventually disables/deletes the returned handle
 * before M5.Mic takes the shared pins. Capture facts are unused here. No task
 * is started, and callers must own the handle's entire lifetime.
 */
bool iterate_kit_i2s_codec_open_playback(
    const struct iterate_kit_i2s_codec_facts *facts, i2s_chan_handle_t *out);
/** Pure validation used by start, before allocating any hardware. */
bool iterate_kit_i2s_codec_valid(const struct iterate_kit_i2s_codec_facts *facts);
/** Validate one direction; open_playback uses this for M5's pin handover. */
bool iterate_kit_i2s_codec_valid_channel(
    i2s_port_t port, const i2s_std_config_t *config,
    const struct iterate_kit_pcm_shape *shape, uint16_t frames, uint8_t descriptors);
/** After board.c's AFTER_I2S scripts and open_codec, raise the amplifier and
 * start the hardware tasks. start only enables preloaded channels: no samples
 * are read or written until finish succeeds. This replaces the global hook.
 */
bool iterate_kit_i2s_codec_finish(struct iterate_kit_audio_codec *out);
/** Release enabled channels after a failed script/open/finish, before tasks
 * exist. The caller then returns false to the loop's durable fault path.
 */
void iterate_kit_i2s_codec_abort(void);
/** Reset the accumulated echo oracle when XMOS changes either selected tap.
 * Latest-frame mic peaks and the lifetime gain-clipped count are retained.
 */
void iterate_kit_i2s_codec_reset_echo_peaks(void);

/** The shared mailbox operations and default properties. extra->start can
 * hand these to the loop before open_codec initializes start_over; no read
 * or write is valid until start_over succeeds. */
struct iterate_kit_audio_codec iterate_kit_i2s_codec(void);
/** Configure only the table amplifier for board-owned channels (Waveshare).
 * facts carries the real TX ring geometry so chime tails keep the rail up.
 * Call after codec open and before start_over. Gated rails start off; the
 * playback wait occurs before ledger credit, preventing a missing syllable.
 */
bool iterate_kit_i2s_codec_prepare_amplifier(const struct iterate_kit_i2s_codec_facts *facts);

/** Start the singleton 16 kHz mono codec over board-owned BLOCKING operations.
 * read fills exactly 320 samples; write consumes 1..320. UNAVAILABLE is a
 * fence/no frame, not a driver failure. The capture task immediately retries
 * UNAVAILABLE: a fenced read MUST block for one frame period (20 ms) before
 * returning it, or priority 19 spins core 1. A repeatedly fenced hardware
 * write must likewise wait 20 ms. The public mailbox ops remain nonblocking;
 * failed writes receive no ledger credit.
 * Only the two hardware tasks call these operations (capture: priority 19,
 * playback: 20; core 1, 4 KiB). Depth-one mailboxes bound latency and expose
 * nonblocking read/write to the loop. Startup capture is not counted as loss.
 * out receives reference-free, unity-gain properties; boards with a volume
 * control retain their own properties on the returned codec. Start once per
 * boot, after clocks, codec and amplifier are ready. Failure leaves no tasks.
 */
bool iterate_kit_i2s_codec_start_over(
    enum iterate_kit_status (*read)(void *, int16_t *, size_t),
    enum iterate_kit_status (*write)(void *, const int16_t *, size_t),
    void *context, uint16_t ring_ms, struct iterate_kit_audio_codec *out);
/** Install a board wait before reserving write credit, before start_over.
 * Waveshare's analogue amplifier settles BEFORE the deadline advances; HAVPE
 * needs no wait. Called only on the playback hardware task, outside the lock.
 * context is the start_over context. NULL leaves the blocking writer ready.
 */
void iterate_kit_i2s_codec_set_before_write(void (*wait)(void *));
/** Install optional playback-task callbacks before start_over.
 * ready runs before taking a sound/mailbox slice, including while idle; M5
 * exchanges pin ownership here and blocks when false. observed runs only after
 * successful writes, with the source flag so M5 mouths stream PCM but silence
 * for chimes. idle runs after a 20 ms empty mailbox wait so its mouth decays.
 * HAVPE/Waveshare leave these NULL. All use the start_over context.
 */
void iterate_kit_i2s_codec_set_playback_callbacks(
    bool (*ready)(void *),
    void (*observed)(void *, const int16_t *, size_t, bool),
    void (*idle)(void *));
/** Drop unsliced sound before M5 mutes its amp and deletes the shared pins. */
void iterate_kit_i2s_codec_drop_pending_sound(void);
/** Count a board-owned mode-switch/recorder failure with the task failures.
 * capture selects the direction. Do not also count an IO_ERROR returned to a
 * hardware task: that path is already counted by start_over.
 */
void iterate_kit_i2s_codec_note_failure(bool capture);
/** Initialize the one locked starvation ledger for a board-owned I/O task
 * (StackChan's 8 ms TDM owner). start_over does this for shared tasks. Call
 * once before starting hardware producers; do not reset it mid-session.
 */
void iterate_kit_i2s_codec_init_ledger(uint16_t ring_ms);
/** Reserve deadline credit immediately BEFORE a blocking hardware write.
 * StackChan credits answer edges only, never its continuously clocked silence
 * or local chimes; doing otherwise would keep its starvation gate green.
 */
void iterate_kit_i2s_codec_reserve_write(uint32_t ms);
/** Undo a failed write's credit; skipped/fenced PCM was never played. */
void iterate_kit_i2s_codec_rollback_write(uint32_t ms);
/** Successful/reserved answer duration, for StackChan's dmaWrittenMs oracle. */
uint32_t iterate_kit_i2s_codec_written_ms(void);

/** Apply the shared starvation phase under one lock; boards own amp actions. */
void iterate_kit_i2s_codec_phase(enum iterate_kit_voice_phase phase);
/** Preempt stream PCM with flash-resident PCM16LE, without mixing or allocation.
 * PCM must remain valid through playback. A replacement takes effect next
 * slice; the stream waits behind its mailbox. NULL/short clips are ignored.
 */
void iterate_kit_i2s_codec_play_sound(const uint8_t *pcm, uint32_t bytes);
/** Whether unsliced local PCM remains; board-specific amp holds are separate. */
bool iterate_kit_i2s_codec_sound_active(void);
/** Armed ring activity including 1500 ms pauses within an answer (HAVPE's
 * echo oracle window); this does not include a local sound's amp hold.
 */
bool iterate_kit_i2s_codec_speaker_is_playing(void);
/** Append task/ledger health and, for table-owned channels, DMA overflows
 * and the raw/clean gain oracle. Return 0 on insufficient space.
 * Counters are copied under the codec lock; uses health_append_fields' contract.
 */
size_t iterate_kit_i2s_codec_health(char *out, size_t capacity);

#ifdef __cplusplus
}
#endif
#endif
