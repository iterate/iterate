#include "iterate/kit/voice_uplink.h"

bool iterate_kit_voice_uplink_capturing(const struct iterate_kit_voice_uplink *u) {
  return u->state == ITERATE_KIT_UPLINK_TALKING ||
      (u->state == ITERATE_KIT_UPLINK_BUFFERING && !u->released);
}

bool iterate_kit_voice_uplink_active(const struct iterate_kit_voice_uplink *u) {
  return u->state == ITERATE_KIT_UPLINK_TALKING ||
      u->state == ITERATE_KIT_UPLINK_FLUSHING;
}

void iterate_kit_voice_uplink_reset(
    struct iterate_kit_voice_uplink *u,
    const struct iterate_kit_voice_uplink_io *io) {
  if (u->state != ITERATE_KIT_UPLINK_IDLE) {
    u->frames_dropped += (uint32_t)io->queued(io->context);
  }
  u->state = ITERATE_KIT_UPLINK_IDLE;
  u->released = false;
  u->blocked_until_release = false;
  u->frame_sequence = 0U;
  u->flush_frames_left = 0U;
  u->drain_at_ms = 0U;
  u->jammed_since_ms = 0U;
  io->clear(io->context);
}

static void fail(struct iterate_kit_voice_uplink *u,
                 const struct iterate_kit_voice_uplink_io *io,
                 enum iterate_kit_voice_uplink_event event,
                 enum capnweb_status status) {
  iterate_kit_voice_uplink_reset(u, io);
  u->state = ITERATE_KIT_UPLINK_FAILED;
  io->notify(io->context, event, status);
}

static bool mark(struct iterate_kit_voice_uplink *u,
                 struct iterate_kit_voicelab *voicelab,
                 const struct iterate_kit_voice_uplink_io *io,
                 enum iterate_kit_voicelab_turn turn) {
  if (!u->marks_turns) return true;
  const enum capnweb_status status = iterate_kit_voicelab_mark_turn(voicelab, turn);
  if (status == CAPNWEB_OK) return true;
  ++u->marker_failures;
  /* A one-way append can leave the session terminal. Never retry an ambiguous
   * marker/audio publication: the adapter replaces the failed session. */
  fail(u, io, ITERATE_KIT_UPLINK_PUBLICATION_FAILED, status);
  return false;
}

void iterate_kit_voice_uplink_step(
    struct iterate_kit_voice_uplink *u,
    struct iterate_kit_voicelab *voicelab,
    const struct iterate_kit_voice_uplink_io *io,
    const struct iterate_kit_voice_uplink_input *in) {
  if (u->state == ITERATE_KIT_UPLINK_FAILED) return;
  if (!in->wants_talk) u->blocked_until_release = false;
  if (u->state == ITERATE_KIT_UPLINK_BUFFERING && u->released &&
      in->wants_talk && !u->blocked_until_release) {
    iterate_kit_voice_uplink_reset(u, io);
  }
  if (u->state == ITERATE_KIT_UPLINK_IDLE) {
    if (!in->wants_talk || u->blocked_until_release) return;
    io->clear(io->context);
    if (io->prepare != NULL && !io->prepare(io->context)) {
      fail(u, io, ITERATE_KIT_UPLINK_PUBLICATION_FAILED, CAPNWEB_E_STATE);
      return;
    }
    u->state = ITERATE_KIT_UPLINK_BUFFERING;
    u->marks_turns = in->marks_turns;
    u->released = false;
    u->turn_started_ms = in->now_ms;
    u->frame_sequence = 0U;
    u->drain_at_ms = 0U;
  }

  const bool limited = u->marks_turns && !u->released &&
      in->now_ms - u->turn_started_ms > ITERATE_KIT_VOICE_TURN_MAX_MS;
  if (!u->released && (!in->wants_talk || limited)) {
    u->released = true;
    u->flush_frames_left = io->queued(io->context);
    u->flush_deadline_ms = in->now_ms + ITERATE_KIT_VOICE_TURN_FLUSH_TIMEOUT_MS;
    if (limited) {
      u->blocked_until_release = true;
      io->notify(io->context, ITERATE_KIT_UPLINK_TURN_LIMIT, CAPNWEB_OK);
    }
    io->notify(io->context, ITERATE_KIT_UPLINK_RELEASED, CAPNWEB_OK);
    if (u->state == ITERATE_KIT_UPLINK_TALKING) {
      u->state = ITERATE_KIT_UPLINK_FLUSHING;
    }
  }
  if (u->state == ITERATE_KIT_UPLINK_BUFFERING) {
    if (u->released && io->queued(io->context) == 0U) {
      u->state = ITERATE_KIT_UPLINK_IDLE;
      io->notify(io->context, ITERATE_KIT_UPLINK_STOPPED, CAPNWEB_OK);
      return;
    }
    if (!in->ready || in->outbox_free < 3U) {
      if (in->now_ms - u->turn_started_ms > ITERATE_KIT_VOICE_TURN_MAX_MS) {
        ++u->backpressure_failures;
        fail(u, io, ITERATE_KIT_UPLINK_BACKPRESSURE_FAILED, CAPNWEB_E_STATE);
      }
      return;
    }
    if (!mark(u, voicelab, io, ITERATE_KIT_VOICELAB_TURN_START)) return;
    u->state = u->released ? ITERATE_KIT_UPLINK_FLUSHING : ITERATE_KIT_UPLINK_TALKING;
    /* Dial time must not consume the budget for sending a released tail. */
    if (u->released) {
      u->flush_deadline_ms = in->now_ms + ITERATE_KIT_VOICE_TURN_FLUSH_TIMEOUT_MS;
    }
    io->notify(io->context, ITERATE_KIT_UPLINK_STARTED, CAPNWEB_OK);
  }

  size_t queued = io->queued(io->context);
  if (u->state == ITERATE_KIT_UPLINK_FLUSHING && queued > u->flush_frames_left) {
    queued = u->flush_frames_left;
  }
  if (u->state == ITERATE_KIT_UPLINK_FLUSHING &&
      in->now_ms >= u->flush_deadline_ms && u->flush_frames_left != 0U) {
    u->frames_dropped += (uint32_t)u->flush_frames_left;
    u->flush_frames_left = 0U;
    io->clear(io->context);
    queued = 0U;
    io->notify(io->context, ITERATE_KIT_UPLINK_TAIL_DROPPED, CAPNWEB_OK);
  }
  const bool jammed = queued >= ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH / 2U &&
      (!in->ready || in->outbox_free < ITERATE_KIT_VOICE_MIC_OUTBOX_RESERVE);
  if (!jammed) u->jammed_since_ms = 0U;
  else if (u->jammed_since_ms == 0U) u->jammed_since_ms = in->now_ms;
  else if (in->now_ms - u->jammed_since_ms > 3000U) {
    ++u->backpressure_failures;
    fail(u, io, ITERATE_KIT_UPLINK_BACKPRESSURE_FAILED, CAPNWEB_E_STATE);
    return;
  }

  const size_t needed = u->released || in->source_finished
      ? 1U : ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND;
  if (in->ready && queued >= needed &&
      in->outbox_free >= ITERATE_KIT_VOICE_MIC_OUTBOX_RESERVE &&
      (in->now_ms >= u->drain_at_ms || u->released ||
       queued >= ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND * 2U)) {
    const size_t take = queued < ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND
        ? queued : ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND;
    const uint8_t *frames[ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND];
    size_t read = 0U;
    for (; read < take; ++read) {
      if (!io->read(io->context, u->frames[read])) break;
      frames[read] = u->frames[read];
    }
    if (read != take) {
      u->frames_dropped += (uint32_t)read;
      ++u->send_failures;
      fail(u, io, ITERATE_KIT_UPLINK_PUBLICATION_FAILED, CAPNWEB_E_STATE);
      return;
    }
    const enum capnweb_status status = iterate_kit_voicelab_append_frames(
        voicelab, frames, take, ITERATE_KIT_VOICE_FRAME_BYTES,
        u->frame_sequence, in->now_ms);
    if (status != CAPNWEB_OK) {
      u->frames_dropped += (uint32_t)take;
      ++u->send_failures;
      fail(u, io, ITERATE_KIT_UPLINK_PUBLICATION_FAILED, status);
      return;
    }
    u->frame_sequence += (uint32_t)take;
    u->drain_at_ms = in->now_ms + take * ITERATE_KIT_VOICE_FRAME_MS;
    if (u->released) u->flush_frames_left -= take;
  }
  if (u->state == ITERATE_KIT_UPLINK_FLUSHING && u->flush_frames_left == 0U) {
    if (!in->ready || in->outbox_free < 3U) {
      if (in->now_ms >= u->flush_deadline_ms) {
        ++u->backpressure_failures;
        fail(u, io, ITERATE_KIT_UPLINK_BACKPRESSURE_FAILED, CAPNWEB_E_STATE);
      }
      return;
    }
    if (!mark(u, voicelab, io, ITERATE_KIT_VOICELAB_TURN_COMMIT)) return;
    u->state = ITERATE_KIT_UPLINK_IDLE;
    io->clear(io->context);
    io->notify(io->context, u->marks_turns ? ITERATE_KIT_UPLINK_COMMITTED
                                        : ITERATE_KIT_UPLINK_STOPPED, CAPNWEB_OK);
  }
}
