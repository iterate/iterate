#ifndef ITERATE_KIT_PLATFORMS_RELEASE_OWNED_HANDLE_HPP
#define ITERATE_KIT_PLATFORMS_RELEASE_OWNED_HANDLE_HPP

namespace iterate::kit::platforms {

/**
 * Releases a driver handle without losing ownership on cleanup failure.
 *
 * Embedded driver teardown is not infallible. In particular, a failed delete
 * may leave an ISR registered against the handle and its adjacent callback
 * context. Unconditionally nulling software fields in that branch converts a
 * bounded, retryable resource into an untracked callback/use-after-reset risk.
 *
 * `release` performs the physical driver operation and returns its native
 * result. `clearSideState` runs only once absence is proven: either the handle
 * was already empty or physical release returned `success`. The helper owns no
 * storage and introduces no retry; the outer lifecycle decides whether and
 * when a later cleanup attempt is safe.
 */
template<
    typename Handle,
    typename Result,
    typename Release,
    typename ClearSideState>
Result releaseOwnedHandle(
    Handle &handle,
    Result success,
    Release release,
    ClearSideState clearSideState) {
  if (handle == Handle{}) {
    /*
     * With no physical object, stale callback pointers are software residue,
     * not evidence worth retaining. Normalising them makes repeated release
     * idempotent and repairs a partially constructed local state.
     */
    clearSideState();
    return success;
  }

  const auto result = release(handle);
  if (result != success) {
    return result;
  }
  handle = Handle{};
  clearSideState();
  return result;
}

}  // namespace iterate::kit::platforms

#endif
