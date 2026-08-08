#ifndef ITERATE_KIT_ITX_OUTBOX_SENDER_H
#define ITERATE_KIT_ITX_OUTBOX_SENDER_H

#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/status.h"
#include "iterate/kit/websocket_tx.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum iterate_kit_websocket_tx_result
    (*iterate_kit_itx_outbox_send_fn)(
        void *context, const void *message, size_t length);

enum iterate_kit_itx_outbox_poll_result {
  ITERATE_KIT_ITX_OUTBOX_IDLE = 0,
  ITERATE_KIT_ITX_OUTBOX_SENT,
  ITERATE_KIT_ITX_OUTBOX_PROGRESS,
  ITERATE_KIT_ITX_OUTBOX_DEFERRED,
  ITERATE_KIT_ITX_OUTBOX_FAILED,
};

struct iterate_kit_itx_outbox_sender_metrics {
  uint32_t messages_sent;
  uint32_t messages_discarded;
  uint32_t send_failures;
};

/**
 * One-owner bridge from complete Cap'n Web ring slots to resumable frames.
 *
 * A short lower write must retain both the portable writer cursor and the ring
 * head: releasing the slot would let its producer overwrite bytes still
 * needed to validate/resume the same logical frame. discard() releases exactly
 * once at a generation boundary and drains queued session-scoped messages.
 * Callers must reset/close the writer before discard() so no encoded suffix can
 * retain a pointer after the producer is allowed to reuse the slot.
 */
struct iterate_kit_itx_outbox_sender {
  struct iterate_kit_spsc_ring *ring;
  const void *message;
  size_t length;
  uint32_t messages_sent;
  uint32_t messages_discarded;
  uint32_t send_failures;
  bool acquired;
  bool initialized;
};

enum iterate_kit_status iterate_kit_itx_outbox_sender_init(
    struct iterate_kit_itx_outbox_sender *sender,
    struct iterate_kit_spsc_ring *ring);

enum iterate_kit_itx_outbox_poll_result
iterate_kit_itx_outbox_sender_poll(
    struct iterate_kit_itx_outbox_sender *sender,
    iterate_kit_itx_outbox_send_fn send,
    void *send_context);

void iterate_kit_itx_outbox_sender_discard(
    struct iterate_kit_itx_outbox_sender *sender);

void iterate_kit_itx_outbox_sender_metrics(
    const struct iterate_kit_itx_outbox_sender *sender,
    struct iterate_kit_itx_outbox_sender_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
