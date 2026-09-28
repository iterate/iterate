#include "iterate/kit/itx_outbox_sender.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

struct short_writer {
  const void *first_message;
  size_t first_length;
  unsigned int calls;
};

static enum iterate_kit_websocket_tx_result short_send(
    void *context, const void *message, size_t length) {
  struct short_writer *writer = context;
  ++writer->calls;
  if (writer->calls == 1U) {
    writer->first_message = message;
    writer->first_length = length;
    return ITERATE_KIT_WEBSOCKET_TX_PROGRESS;
  }
  assert(message == writer->first_message);
  assert(length == writer->first_length);
  return ITERATE_KIT_WEBSOCKET_TX_SENT;
}

/*
 * TLS can accept only a frame prefix while the Cap'n Web producer is ready to
 * reuse its next ring slot. Releasing the head after that prefix loses the
 * suffix; reacquiring it emits a duplicate frame. This pins the shared sender
 * to one borrowed slot until the portable writer reports full completion.
 */
static void short_write_resumes_one_outbox_slot(void) {
  uint8_t storage[2][16];
  size_t lengths[2];
  void *slot;
  size_t capacity;
  struct iterate_kit_spsc_ring ring;
  struct iterate_kit_itx_outbox_sender sender;
  struct iterate_kit_itx_outbox_sender_metrics metrics;
  struct short_writer writer = {0};
  assert(iterate_kit_spsc_ring_init(
             &ring, storage, sizeof(storage[0]), 2U, lengths) ==
         ITERATE_KIT_OK);
  assert(iterate_kit_spsc_ring_write_acquire(
             &ring, &slot, &capacity) == ITERATE_KIT_OK);
  assert(capacity >= 3U);
  memcpy(slot, "rpc", 3U);
  assert(iterate_kit_spsc_ring_write_publish(&ring, 3U) == ITERATE_KIT_OK);
  assert(iterate_kit_itx_outbox_sender_init(&sender, &ring) == ITERATE_KIT_OK);
  assert(iterate_kit_itx_outbox_sender_poll(
             &sender, short_send, &writer) ==
         ITERATE_KIT_ITX_OUTBOX_PROGRESS);
  assert(ring.read_acquired);
  assert(iterate_kit_itx_outbox_sender_poll(
             &sender, short_send, &writer) ==
         ITERATE_KIT_ITX_OUTBOX_SENT);
  assert(!ring.read_acquired);
  iterate_kit_itx_outbox_sender_metrics(&sender, &metrics);
  assert(metrics.messages_sent == 1U);
  assert(metrics.messages_discarded == 0U);
  assert(writer.calls == 2U);
}

int main(void) {
  short_write_resumes_one_outbox_slot();
  return 0;
}
