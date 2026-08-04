#ifndef ITERATE_KIT_CAPABILITIES_SUBSCRIPTION_H
#define ITERATE_KIT_CAPABILITIES_SUBSCRIPTION_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * A stable owner key is an optional callback-lifetime identity, not a topic or
 * a second routing tree. It exists because the PCM and Cap'n Web sockets have
 * independent generations: replacing `/pcm` must be able to supersede the
 * callback owned by the previous userspace generation without evicting an
 * unrelated diagnostic observer.
 *
 * Keeping the decoded key inline makes the RAM cost exact and removes hashing
 * collisions from a control-plane ownership decision. Thirty-one UTF-8 bytes
 * plus the terminator comfortably fits the reviewed `iterate-kit-voice-pcm-v1`
 * key. Longer identities are rejected instead of truncated or allocated.
 */
#define ITERATE_KIT_SUBSCRIPTION_OWNER_KEY_CAPACITY 32U

struct iterate_kit_subscription_owner_key {
  char bytes[ITERATE_KIT_SUBSCRIPTION_OWNER_KEY_CAPACITY];
  size_t length;
  bool present;
};

#ifdef __cplusplus
}
#endif

#endif
