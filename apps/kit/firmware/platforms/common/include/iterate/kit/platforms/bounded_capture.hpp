#ifndef ITERATE_KIT_PLATFORMS_BOUNDED_CAPTURE_HPP
#define ITERATE_KIT_PLATFORMS_BOUNDED_CAPTURE_HPP

#include "iterate/kit/audio.h"

#include <cstddef>
#include <cstdint>

namespace iterate::kit::platforms {

/**
 * Allocation-free bridge from an asynchronous recorder into the bounded PCM
 * lane. Two frame buffers keep both slots of M5Unified's recorder queue armed:
 * while one completed frame is handed to egress, hardware can continue filling
 * the other. Two is deliberately a hardware-continuity budget, not a backlog:
 * adding a deeper FIFO would reduce visible drops by preserving speech that is
 * already too old for a realtime conversation.
 *
 * One audio/application task owns the adapter and calls start(), stop(), and
 * pump(); there are no atomics, locks, allocations, or waits. The recorder owns
 * a buffer only while its state is `recording`. The submit callback may borrow
 * one completed buffer, but the audio lifecycle module does not call pump()
 * again until that borrow has completed; the next pump can therefore release
 * it before scheduling the buffer again. Violating that external sequencing is
 * a use-after-reuse bug, so the state machine returns STATE_ERROR whenever the
 * observable recorder counts contradict its ledger.
 *
 * The adapter assumes the recorder completes queued buffers in submission
 * order, as M5Unified does. It never reaches into controller state and does not
 * retry rejected frames: upstream owns drop/restart policy and diagnostics.
 *
 * Recorder must provide:
 *   size_t isRecording() const;
 *   bool record(int16_t *, size_t, uint32_t, bool);
 */
template<std::size_t SampleCount, std::uint32_t SampleRate>
class BoundedCapture {
  static_assert(SampleCount > 0U);
  static_assert(SampleRate > 0U);

 public:
  /*
   * M5Unified exposes two recorder queue slots. Encoding that number in the
   * type keeps the complete static audio memory cost measurable at compile
   * time and prevents a future "helpful" queue expansion from adding latency.
   */
  static constexpr std::uint8_t frameBufferCount = 2U;

  void start(std::uint8_t completedFramesToDiscard) {
    /*
     * Starting a hardware microphone can produce a transient frame. The device
     * adapter chooses how many completed frames to discard, but the discard is
     * performed here so those samples can never reach egress by accident.
     */
    resetQueues();
    completedFramesToDiscard_ = completedFramesToDiscard;
  }

  void stop() {
    resetQueues();
    completedFramesToDiscard_ = 0U;
  }

  template<typename Recorder>
  iterate_kit_status pump(
      Recorder &recorder,
      iterate_kit_audio_capture_submit_fn submit,
      void *submitContext) {
    if (submit == nullptr) {
      return ITERATE_KIT_INVALID_ARGUMENT;
    }

    if (submitted_) {
      /*
       * The lifecycle contract guarantees the prior submit borrow ended before
       * this pump. Releasing here, rather than copying into a third buffer,
       * preserves continuous two-slot capture with the smallest fixed RAM cost.
       */
      if (states_[submittedIndex_] != BufferState::submitted) {
        return ITERATE_KIT_STATE_ERROR;
      }
      states_[submittedIndex_] = BufferState::free;
      submitted_ = false;
    }

    const std::size_t hardwarePending = recorder.isRecording();
    if (hardwarePending > recordingCount_) {
      /*
       * Hardware cannot legitimately own more buffers than this adapter handed
       * it. Treat the mismatch as state corruption instead of guessing which
       * sample pointer remains live.
       */
      return ITERATE_KIT_STATE_ERROR;
    }
    while (recordingCount_ > hardwarePending) {
      /*
       * A falling hardware-pending count is the only completion signal exposed
       * by M5Unified. Its FIFO guarantee lets us move exactly the oldest
       * recording buffer to completed without polling or callback allocation.
       */
      const std::uint8_t completedIndex =
          recordingOrder_[recordingHead_];
      if (completedIndex >= bufferCount ||
          states_[completedIndex] != BufferState::recording ||
          completedCount_ >= bufferCount) {
        return ITERATE_KIT_STATE_ERROR;
      }
      recordingHead_ =
          static_cast<std::uint8_t>(
              (recordingHead_ + 1U) % bufferCount);
      --recordingCount_;
      states_[completedIndex] = BufferState::completed;
      const std::uint8_t completedTail =
          static_cast<std::uint8_t>(
              (completedHead_ + completedCount_) % bufferCount);
      completedOrder_[completedTail] = completedIndex;
      ++completedCount_;
    }

    while (completedCount_ > 0U &&
           completedFramesToDiscard_ > 0U) {
      /*
       * Discard only after hardware completion. Reusing an in-flight buffer to
       * skip startup samples would let DMA overwrite memory it still owns.
       */
      const std::uint8_t discardedIndex =
          completedOrder_[completedHead_];
      if (discardedIndex >= bufferCount ||
          states_[discardedIndex] != BufferState::completed) {
        return ITERATE_KIT_STATE_ERROR;
      }
      completedHead_ =
          static_cast<std::uint8_t>(
              (completedHead_ + 1U) % bufferCount);
      --completedCount_;
      states_[discardedIndex] = BufferState::free;
      --completedFramesToDiscard_;
    }

    while (recordingCount_ < bufferCount) {
      const std::uint8_t freeIndex = findFreeBuffer();
      if (freeIndex >= bufferCount) {
        break;
      }
      if (!recorder.record(
              samples_[freeIndex],
              SampleCount,
              SampleRate,
              false)) {
        /*
         * A full/unavailable hardware queue is reported immediately. Busy
         * waiting would delay socket service and playback; allocating another
         * frame would merely turn the condition into stale queued speech.
         */
        return ITERATE_KIT_UNAVAILABLE;
      }
      states_[freeIndex] = BufferState::recording;
      const std::uint8_t recordingTail =
          static_cast<std::uint8_t>(
              (recordingHead_ + recordingCount_) % bufferCount);
      recordingOrder_[recordingTail] = freeIndex;
      ++recordingCount_;
    }

    if (completedCount_ == 0U) {
      return ITERATE_KIT_OK;
    }
    const std::uint8_t submitIndex =
        completedOrder_[completedHead_];
    if (submitIndex >= bufferCount ||
        states_[submitIndex] != BufferState::completed) {
      return ITERATE_KIT_STATE_ERROR;
    }
    completedHead_ =
        static_cast<std::uint8_t>(
            (completedHead_ + 1U) % bufferCount);
    --completedCount_;
    const iterate_kit_status status = submit(
        submitContext,
        samples_[submitIndex],
        SampleCount,
        SampleRate);
    if (status != ITERATE_KIT_OK) {
      /*
       * A rejected realtime frame is released, not retried. The submitter
       * classifies loss/backpressure and may reset its transport epoch; keeping
       * this buffer would stop new microphone samples while stale audio waits.
       */
      states_[submitIndex] = BufferState::free;
      return status;
    }
    states_[submitIndex] = BufferState::submitted;
    submittedIndex_ = submitIndex;
    submitted_ = true;
    return ITERATE_KIT_OK;
  }

 private:
  static constexpr std::uint8_t bufferCount = frameBufferCount;

  enum class BufferState : std::uint8_t {
    free,
    recording,
    completed,
    submitted,
  };

  /*
   * Queue indices and state labels form one owner-task ledger over the two
   * sample arrays. Resetting never calls hardware; callers must stop/release
   * the recorder first when hardware may still retain pointers.
   */
  void resetQueues() {
    for (std::uint8_t index = 0U;
         index < bufferCount;
         ++index) {
      states_[index] = BufferState::free;
    }
    recordingHead_ = 0U;
    recordingCount_ = 0U;
    completedHead_ = 0U;
    completedCount_ = 0U;
    submittedIndex_ = 0U;
    submitted_ = false;
  }

  std::uint8_t findFreeBuffer() const {
    for (std::uint8_t index = 0U;
         index < bufferCount;
         ++index) {
      if (states_[index] == BufferState::free) {
        return index;
      }
    }
    return bufferCount;
  }

  /*
   * All audio storage is inline: SampleCount * 2 * sizeof(int16_t), plus a few
   * bytes of state. There is no hidden capacity and therefore no memory growth
   * under network loss or prolonged push-to-talk.
   */
  std::int16_t samples_[bufferCount][SampleCount]{};
  BufferState states_[bufferCount]{};
  std::uint8_t recordingOrder_[bufferCount]{};
  std::uint8_t completedOrder_[bufferCount]{};
  std::uint8_t recordingHead_ = 0U;
  std::uint8_t recordingCount_ = 0U;
  std::uint8_t completedHead_ = 0U;
  std::uint8_t completedCount_ = 0U;
  std::uint8_t submittedIndex_ = 0U;
  std::uint8_t completedFramesToDiscard_ = 0U;
  bool submitted_ = false;
};

}  // namespace iterate::kit::platforms

#endif
