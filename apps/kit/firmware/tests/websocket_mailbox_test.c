#include "iterate/kit/websocket_text.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      fprintf(stderr, "%s:%d: check failed: %s\n",                         \
          __FILE__, __LINE__, #condition);                                   \
      abort();                                                               \
    }                                                                        \
  } while (0)

enum {
  SLOT_COUNT = 2,
  SLOT_CAPACITY = 16,
};

struct fixture {
  struct iterate_kit_spsc_ring ring;
  char storage[SLOT_COUNT][SLOT_CAPACITY];
  size_t lengths[SLOT_COUNT];
};

static void fixture_init(struct fixture *fixture) {
  memset(fixture, 0, sizeof(*fixture));
  CHECK(iterate_kit_spsc_ring_init(
      &fixture->ring,
      fixture->storage,
      SLOT_CAPACITY,
      SLOT_COUNT,
      fixture->lengths) == ITERATE_KIT_OK);
}

static void emit(
    struct iterate_kit_websocket_text_outbox *outbox,
    const char *first,
    const char *second) {
  CHECK(iterate_kit_websocket_text_outbox_send(
      outbox, CAPNWEB_TEXT_BEGIN, NULL, 0U) == CAPNWEB_OK);
  CHECK(iterate_kit_websocket_text_outbox_send(
      outbox, CAPNWEB_TEXT_DATA, first, strlen(first)) ==
      CAPNWEB_OK);
  if (second[0] != '\0') {
    CHECK(iterate_kit_websocket_text_outbox_send(
        outbox, CAPNWEB_TEXT_DATA, second, strlen(second)) ==
        CAPNWEB_OK);
  }
  CHECK(iterate_kit_websocket_text_outbox_send(
      outbox, CAPNWEB_TEXT_END, NULL, 0U) == CAPNWEB_OK);
}

/*
 * Cap'n Web can produce one JSON message in several fragments while the
 * socket-owning task is busy servicing PCM. Sending each fragment directly
 * from the protocol task was rejected because a slow socket would then stall
 * unrelated capability work. This proves the producer retains one ring slot
 * until END and publishes exactly one complete message; only publication
 * transfers ownership to the network consumer.
 */
static void outbox_assembles_without_touching_the_socket(void) {
  struct fixture fixture;
  struct iterate_kit_websocket_text_outbox outbox;
  const void *message;
  size_t length;
  fixture_init(&fixture);
  CHECK(iterate_kit_websocket_text_outbox_init(
      &outbox, &fixture.ring) == CAPNWEB_OK);

  emit(&outbox, "abc", "def");
  CHECK(iterate_kit_spsc_ring_read_acquire(
      &fixture.ring, &message, &length) == ITERATE_KIT_OK);
  CHECK(length == 6U);
  CHECK(memcmp(message, "abcdef", length) == 0);
  CHECK(iterate_kit_spsc_ring_read_release(&fixture.ring) ==
      ITERATE_KIT_OK);
}

/*
 * A stalled network task can leave every outbound slot occupied. Blocking,
 * spinning, or silently overwriting an older RPC was rejected: all three can
 * delay audio or corrupt capability ordering. The owner must instead see one
 * immediate, terminal backpressure result, then explicitly reset the adapter
 * after the old messages have been drained or the connection replaced.
 */
static void outbox_backpressure_is_immediate_and_terminal(void) {
  struct fixture fixture;
  struct iterate_kit_websocket_text_outbox outbox;
  struct iterate_kit_spsc_ring_metrics metrics;
  const void *message;
  size_t length;
  fixture_init(&fixture);
  CHECK(iterate_kit_websocket_text_outbox_init(
      &outbox, &fixture.ring) == CAPNWEB_OK);
  emit(&outbox, "one", "");
  emit(&outbox, "two", "");

  CHECK(iterate_kit_websocket_text_outbox_send(
      &outbox, CAPNWEB_TEXT_BEGIN, NULL, 0U) ==
      CAPNWEB_E_TRANSPORT);
  CHECK(iterate_kit_websocket_text_outbox_send(
      &outbox, CAPNWEB_TEXT_BEGIN, NULL, 0U) ==
      CAPNWEB_E_TRANSPORT);
  iterate_kit_spsc_ring_metrics(&fixture.ring, &metrics);
  CHECK(metrics.producer_backpressure == 1U);

  CHECK(iterate_kit_spsc_ring_read_acquire(
      &fixture.ring, &message, &length) == ITERATE_KIT_OK);
  CHECK(iterate_kit_spsc_ring_read_release(&fixture.ring) ==
      ITERATE_KIT_OK);
  CHECK(iterate_kit_spsc_ring_read_acquire(
      &fixture.ring, &message, &length) == ITERATE_KIT_OK);
  CHECK(iterate_kit_spsc_ring_read_release(&fixture.ring) ==
      ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_text_outbox_reset(&outbox) ==
      CAPNWEB_OK);
  emit(&outbox, "fresh", "");
}

/*
 * ESP-IDF may split one WebSocket frame across callbacks and a logical text
 * message across continuation frames. Publishing the first callback, or
 * allocating a second assembly buffer, would expose partial JSON or waste a
 * fixed RAM budget. This proves the network producer writes directly into its
 * acquired slot and transfers it to the protocol consumer only after FIN.
 */
static void inbox_reassembles_directly_into_a_ring_slot(void) {
  struct fixture fixture;
  struct iterate_kit_websocket_text_inbox inbox;
  const void *message;
  size_t length;
  fixture_init(&fixture);
  CHECK(iterate_kit_websocket_text_inbox_init(
      &inbox, &fixture.ring) == CAPNWEB_OK);

  CHECK(iterate_kit_websocket_text_inbox_feed(
      &inbox,
      ITERATE_KIT_WEBSOCKET_TEXT,
      false,
      4U,
      0U,
      "ab",
      2U) == CAPNWEB_OK);
  CHECK(iterate_kit_websocket_text_inbox_feed(
      &inbox,
      ITERATE_KIT_WEBSOCKET_TEXT,
      false,
      4U,
      2U,
      "cd",
      2U) == CAPNWEB_OK);
  CHECK(iterate_kit_websocket_text_inbox_feed(
      &inbox,
      ITERATE_KIT_WEBSOCKET_CONTINUATION,
      true,
      2U,
      0U,
      "ef",
      2U) == CAPNWEB_OK);

  CHECK(iterate_kit_spsc_ring_read_acquire(
      &fixture.ring, &message, &length) == ITERATE_KIT_OK);
  CHECK(length == 6U);
  CHECK(memcmp(message, "abcdef", length) == 0);
  CHECK(iterate_kit_spsc_ring_read_release(&fixture.ring) ==
      ITERATE_KIT_OK);
}

/*
 * Capability dispatch may fall behind while the network task must keep polling
 * the separate realtime PCM lane. Waiting for a free text slot, or overwriting
 * an unread message, would respectively delay audio or violate RPC ordering.
 * A full inbox therefore becomes one observable terminal failure; completed
 * slots remain consumer-owned, and reuse requires an explicit reset after
 * recovery.
 */
static void inbox_never_waits_for_a_slow_consumer(void) {
  struct fixture fixture;
  struct iterate_kit_websocket_text_inbox inbox;
  struct iterate_kit_spsc_ring_metrics metrics;
  const void *message;
  size_t length;
  fixture_init(&fixture);
  CHECK(iterate_kit_websocket_text_inbox_init(
      &inbox, &fixture.ring) == CAPNWEB_OK);

  CHECK(iterate_kit_websocket_text_inbox_feed(
      &inbox,
      ITERATE_KIT_WEBSOCKET_TEXT,
      true,
      3U,
      0U,
      "one",
      3U) == CAPNWEB_OK);
  CHECK(iterate_kit_websocket_text_inbox_feed(
      &inbox,
      ITERATE_KIT_WEBSOCKET_TEXT,
      true,
      3U,
      0U,
      "two",
      3U) == CAPNWEB_OK);
  CHECK(iterate_kit_websocket_text_inbox_feed(
      &inbox,
      ITERATE_KIT_WEBSOCKET_TEXT,
      true,
      5U,
      0U,
      "three",
      5U) == CAPNWEB_E_TRANSPORT);

  iterate_kit_spsc_ring_metrics(&fixture.ring, &metrics);
  CHECK(metrics.messages_published == 2U);
  CHECK(metrics.producer_backpressure == 1U);
  CHECK(metrics.current_slots == 2U);

  CHECK(iterate_kit_spsc_ring_read_acquire(
      &fixture.ring, &message, &length) == ITERATE_KIT_OK);
  CHECK(iterate_kit_spsc_ring_read_release(&fixture.ring) ==
      ITERATE_KIT_OK);
  CHECK(iterate_kit_spsc_ring_read_acquire(
      &fixture.ring, &message, &length) == ITERATE_KIT_OK);
  CHECK(iterate_kit_spsc_ring_read_release(&fixture.ring) ==
      ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_text_inbox_reset(&inbox) ==
      CAPNWEB_OK);
  CHECK(iterate_kit_websocket_text_inbox_feed(
      &inbox,
      ITERATE_KIT_WEBSOCKET_TEXT,
      true,
      5U,
      0U,
      "fresh",
      5U) == CAPNWEB_OK);
}

int main(void) {
  outbox_assembles_without_touching_the_socket();
  outbox_backpressure_is_immediate_and_terminal();
  inbox_reassembles_directly_into_a_ring_slot();
  inbox_never_waits_for_a_slow_consumer();
  return 0;
}
