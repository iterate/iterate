#ifndef ITERATE_KIT_PLATFORMS_BOUNDED_EVENT_COUNTER_HPP
#define ITERATE_KIT_PLATFORMS_BOUNDED_EVENT_COUNTER_HPP

#include <cstdint>
#include <limits>

namespace iterate::kit::platforms {

/**
 * Single-owner lifetime event counter which saturates instead of wrapping.
 *
 * Diagnostics are evidence, not throughput state. Once a device has observed
 * UINT32_MAX incidents, a later increment must not make it look healthy again.
 * This tiny value type deliberately contains no atomic or lock: its owner must
 * provide synchronization just as it does for the policy metrics beside it.
 * Keeping that ownership explicit avoids paying a cross-core atomic operation
 * in paths whose producer and sampler are already the same application task.
 */
class BoundedEventCounter {
 public:
  void record() {
    add(1U);
  }

  void add(std::uint32_t amount) {
    const auto maximum =
        std::numeric_limits<std::uint32_t>::max();
    if (value_ >= maximum) {
      return;
    }
    const auto available = maximum - value_;
    value_ = amount > available
        ? maximum
        : value_ + amount;
  }

  std::uint32_t value() const {
    return value_;
  }

 private:
  std::uint32_t value_ = 0U;
};

}  // namespace iterate::kit::platforms

#endif
