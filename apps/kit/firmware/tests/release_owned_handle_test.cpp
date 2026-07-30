#include "iterate/kit/platforms/release_owned_handle.hpp"

#include <cassert>
#include <cstdint>

namespace {

enum class DriverResult : std::uint8_t {
  ok = 0U,
  deleteFailed,
};

/*
 * ESP-IDF can refuse i2s_del_channel() after an earlier lifecycle operation
 * fails. Its registered ISR may therefore remain live. Losing the only handle
 * or clearing callback context in that branch creates an unquarantined ISR
 * which can access reset/reused state. This seam models the exact target
 * ownership rule without pretending to emulate the I2S driver: a failed
 * physical release retains both handle and side state, and a later successful
 * retry clears them together.
 */
void failedPhysicalDeleteRetainsHandleAndCallbackState() {
  int physicalChannel = 7;
  int *ownedHandle = &physicalChannel;
  bool callbackStateLive = true;
  std::uint32_t deleteAttempts = 0U;

  auto result =
      iterate::kit::platforms::releaseOwnedHandle(
          ownedHandle,
          DriverResult::ok,
          [&](int *observedHandle) {
            assert(observedHandle == &physicalChannel);
            ++deleteAttempts;
            return DriverResult::deleteFailed;
          },
          [&]() { callbackStateLive = false; });

  assert(result == DriverResult::deleteFailed);
  assert(ownedHandle == &physicalChannel);
  assert(callbackStateLive);
  assert(deleteAttempts == 1U);

  result = iterate::kit::platforms::releaseOwnedHandle(
      ownedHandle,
      DriverResult::ok,
      [&](int *observedHandle) {
        assert(observedHandle == &physicalChannel);
        ++deleteAttempts;
        return DriverResult::ok;
      },
      [&]() { callbackStateLive = false; });

  assert(result == DriverResult::ok);
  assert(ownedHandle == nullptr);
  assert(!callbackStateLive);
  assert(deleteAttempts == 2U);
}

/*
 * A null physical handle means no callback can still be registered. Running
 * the success cleanup in that state makes release idempotent and repairs any
 * stale software-only callback fields after partial construction without
 * inventing a driver call against nullptr.
 */
void emptyHandleStillNormalisesSideState() {
  int *ownedHandle = nullptr;
  bool callbackStateLive = true;
  bool deleteCalled = false;

  const auto result =
      iterate::kit::platforms::releaseOwnedHandle(
          ownedHandle,
          DriverResult::ok,
          [&](int *) {
            deleteCalled = true;
            return DriverResult::deleteFailed;
          },
          [&]() { callbackStateLive = false; });

  assert(result == DriverResult::ok);
  assert(!deleteCalled);
  assert(!callbackStateLive);
}

}  // namespace

int main() {
  failedPhysicalDeleteRetainsHandleAndCallbackState();
  emptyHandleStillNormalisesSideState();
  return 0;
}
