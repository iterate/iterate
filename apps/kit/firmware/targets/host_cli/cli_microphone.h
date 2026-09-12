#ifndef ITERATE_KIT_CLI_MICROPHONE_H
#define ITERATE_KIT_CLI_MICROPHONE_H

/*
 * cli_microphone: frames captured but not yet sent.
 *
 * Input is read continuously. An active conversation admits frames to this
 * queue, which retains bounded current audio while the uplink cannot keep up.
 *
 * IT DROPS THE OLDEST, and counts it. The alternative — refusing the newest —
 * keeps a queue full of speech from a second ago and sends it late for the
 * rest of the turn, so the provider transcribes a sentence that trails
 * further behind the person with every frame. Dropping the oldest keeps the
 * uplink honest about WHEN it is, at the cost of a gap the sequence numbers
 * make visible.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/voice_device_profile.h"

/** One status per way the queue can refuse work. */
enum cli_microphone_status {
  CLI_MICROPHONE_OK = 0,
  CLI_MICROPHONE_ERR_ARG,
};

/**
 * A bounded queue of whole captured frames.
 *
 * `dropped` is not a diagnostic afterthought: it is the only record that the
 * uplink fell behind, and a turn whose transcript is missing its middle is
 * explained by nothing else.
 */
struct cli_microphone {
  uint8_t frames[ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH]
                [ITERATE_KIT_VOICE_FRAME_BYTES];
  size_t read;
  size_t write;
  size_t used;
  uint32_t dropped;
};

/** Empty the queue, keeping the drop count. Used when a turn ends. */
void cli_microphone_clear(struct cli_microphone *microphone);

/** Frames queued right now. */
size_t cli_microphone_queued(const struct cli_microphone *microphone);

/**
 * Queue one whole frame, displacing the oldest if there is no room.
 *
 * Never fails for want of space: a microphone that refuses input has stopped
 * being a microphone. Displacement is counted in `dropped`.
 */
enum cli_microphone_status cli_microphone_push(
    struct cli_microphone *microphone, const uint8_t *frame, size_t length);

#endif /* ITERATE_KIT_CLI_MICROPHONE_H */
