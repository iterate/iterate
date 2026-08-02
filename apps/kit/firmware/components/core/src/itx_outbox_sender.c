#include "iterate/kit/itx_outbox_sender.h"

#include "iterate/kit/atomic.h"

#include <string.h>

static void release_acquired(
    struct iterate_kit_itx_outbox_sender *sender) {
  if (!sender->acquired) {
    return;
  }
  (void)iterate_kit_spsc_ring_read_release(sender->ring);
  sender->message = NULL;
  sender->length = 0U;
  sender->acquired = false;
}

enum iterate_kit_status iterate_kit_itx_outbox_sender_init(
    struct iterate_kit_itx_outbox_sender *sender,
    struct iterate_kit_spsc_ring *ring) {
  if (sender == NULL || ring == NULL || !ring->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(sender, 0, sizeof(*sender));
  sender->ring = ring;
  sender->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_itx_outbox_poll_result
iterate_kit_itx_outbox_sender_poll(
    struct iterate_kit_itx_outbox_sender *sender,
    iterate_kit_itx_outbox_send_fn send,
    void *send_context) {
  enum iterate_kit_websocket_tx_result result;
  if (sender == NULL || !sender->initialized || send == NULL) {
    return ITERATE_KIT_ITX_OUTBOX_FAILED;
  }
  if (!sender->acquired) {
    if (iterate_kit_spsc_ring_read_acquire(
            sender->ring, &sender->message, &sender->length) !=
        ITERATE_KIT_OK) {
      return ITERATE_KIT_ITX_OUTBOX_IDLE;
    }
    sender->acquired = true;
  }
  result = send(send_context, sender->message, sender->length);
  if (result == ITERATE_KIT_WEBSOCKET_TX_SENT) {
    release_acquired(sender);
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &sender->messages_sent);
    return ITERATE_KIT_ITX_OUTBOX_SENT;
  }
  if (result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS) {
    return ITERATE_KIT_ITX_OUTBOX_PROGRESS;
  }
  if (result == ITERATE_KIT_WEBSOCKET_TX_DEFERRED) {
    return ITERATE_KIT_ITX_OUTBOX_DEFERRED;
  }
  /*
   * Some prefix may already be below the callback. Retrying could duplicate a
   * method call, while retaining the slot across reconnect would reuse Cap'n
   * Web references from the dead generation. Release visibly and force the
   * outer owner to replace the byte stream.
   */
  release_acquired(sender);
  iterate_kit_atomic_saturating_increment_relaxed_u32(
      &sender->messages_discarded);
  iterate_kit_atomic_saturating_increment_relaxed_u32(
      &sender->send_failures);
  return ITERATE_KIT_ITX_OUTBOX_FAILED;
}

void iterate_kit_itx_outbox_sender_discard(
    struct iterate_kit_itx_outbox_sender *sender) {
  const void *message;
  size_t length;
  if (sender == NULL || !sender->initialized) {
    return;
  }
  if (sender->acquired) {
    release_acquired(sender);
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &sender->messages_discarded);
  }
  while (iterate_kit_spsc_ring_read_acquire(
             sender->ring, &message, &length) == ITERATE_KIT_OK) {
    (void)message;
    (void)length;
    (void)iterate_kit_spsc_ring_read_release(sender->ring);
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &sender->messages_discarded);
  }
}

void iterate_kit_itx_outbox_sender_metrics(
    const struct iterate_kit_itx_outbox_sender *sender,
    struct iterate_kit_itx_outbox_sender_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (sender == NULL || !sender->initialized) {
    return;
  }
  metrics->messages_sent =
      iterate_kit_atomic_load_relaxed_u32(&sender->messages_sent);
  metrics->messages_discarded =
      iterate_kit_atomic_load_relaxed_u32(&sender->messages_discarded);
  metrics->send_failures =
      iterate_kit_atomic_load_relaxed_u32(&sender->send_failures);
}
