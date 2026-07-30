#ifndef ITERATE_KIT_PLATFORMS_DISPLAY_REFRESH_GATE_HPP
#define ITERATE_KIT_PLATFORMS_DISPLAY_REFRESH_GATE_HPP

namespace iterate::kit::platforms {

/**
 * Keeps synchronous display work out of the real-time audio interval.
 *
 * Screen drivers can hold SPI/display locks for milliseconds, which is enough
 * to delay a 20 ms microphone or speaker deadline. The gate therefore
 * coalesces any number of requested refreshes into one dirty bit and permits
 * rendering only after realtime audio becomes idle. It is not a frame queue:
 * intermediate visual states may be skipped intentionally because preserving
 * audio timing is the higher-priority product requirement.
 *
 * One device/application task owns all methods. No atomics or locks are needed,
 * and none of the methods allocate or call a display. A device with an
 * independently scheduled display bus may use a different policy rather than
 * weakening this simple invariant.
 *
 * The gate is deliberately zero-initializable so embedding it in a static
 * device runtime does not create a non-zero data image.
 */
class DisplayRefreshGate {
 public:
  void markDirty() noexcept {
    dirty_ = true;
  }

  void observeRealtimeAudioActive(bool active) noexcept {
    if (realtimeAudioActive_ == active) return;
    realtimeAudioActive_ = active;
    /*
     * Force one refresh when audio ends even if no explicit UI field marked
     * dirty. Listening/speaking indicators are commonly suppressed during the
     * critical interval; this transition guarantees the screen catches up once
     * rendering is safe.
     */
    if (!active) dirty_ = true;
  }

  bool consumeIfIdle() noexcept {
    if (realtimeAudioActive_ || !dirty_) return false;
    /*
     * Clear before returning permission so a refresh request raised by later
     * owner-task work remains pending for a subsequent render rather than being
     * accidentally cleared after the expensive display call.
     */
    dirty_ = false;
    return true;
  }

 private:
  bool dirty_;
  bool realtimeAudioActive_;
};

}  // namespace iterate::kit::platforms

#endif
