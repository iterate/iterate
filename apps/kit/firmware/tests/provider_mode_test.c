#include "iterate/kit/provider_mode.h"

#include <assert.h>
#include <stddef.h>

struct memory_store {
  bool readable;
  bool writable;
  uint8_t value;
  size_t reads;
  size_t writes;
  char *events;
  size_t *event_count;
};

struct live_mode {
  uint8_t applied;
  uint8_t announced;
  size_t applies;
  size_t announcements;
  char *events;
  size_t *event_count;
  const uint8_t *current;
  uint8_t current_seen_at_announcement;
};

static bool read_mode(const void *context, uint8_t *mode) {
  struct memory_store *store = (struct memory_store *)context;
  ++store->reads;
  if (!store->readable) return false;
  *mode = store->value;
  return true;
}

static bool write_mode(const void *context, uint8_t mode) {
  struct memory_store *store = (struct memory_store *)context;
  ++store->writes;
  store->events[(*store->event_count)++] = 'W';
  if (!store->writable) return false;
  store->value = mode;
  return true;
}

static void apply_mode(void *context, uint8_t mode) {
  struct live_mode *live = context;
  live->applied = mode;
  ++live->applies;
  live->events[(*live->event_count)++] = 'A';
}

static void announce_mode(void *context, uint8_t mode) {
  struct live_mode *live = context;
  live->announced = mode;
  ++live->announcements;
  live->events[(*live->event_count)++] = 'N';
  live->current_seen_at_announcement = *live->current;
}

int main(void) {
  const struct iterate_kit_provider_mode_options options = {
      .default_mode = 1U,
      .mode_count = 4U,
  };
  struct memory_store memory = {.readable = true, .writable = true, .value = 3U};
  const struct iterate_kit_provider_mode_store store = {
      .context = &memory,
      .read = read_mode,
      .write = write_mode,
  };
  char events[12] = {0};
  size_t event_count = 0U;
  struct live_mode live = {
      .events = events,
      .event_count = &event_count,
  };
  uint8_t current;
  memory.events = events;
  memory.event_count = &event_count;

  assert(iterate_kit_provider_mode_load(&options, &store) == 3U);
  memory.value = 4U;
  assert(iterate_kit_provider_mode_load(&options, &store) == 1U);
  memory.readable = false;
  assert(iterate_kit_provider_mode_load(&options, &store) == 1U);

  current = 3U;
  live.current = &current;
  assert(iterate_kit_provider_mode_adopt(
      &options, &store, &current, 2U, false, apply_mode, announce_mode, &live) ==
      ITERATE_KIT_PROVIDER_MODE_ADOPTION_APPLIED);
  assert(current == 2U);
  assert(live.applied == 2U && live.applies == 1U);
  assert(live.announcements == 0U);
  assert(memory.writes == 0U);
  assert(event_count == 1U && events[0] == 'A');

  memory.readable = true;
  assert(iterate_kit_provider_mode_adopt(
      &options, &store, &current, 2U, true, apply_mode, announce_mode, &live) ==
      ITERATE_KIT_PROVIDER_MODE_ADOPTION_APPLIED);
  assert(current == 2U);
  assert(live.applies == 2U);
  assert(live.announced == 2U && live.announcements == 1U);
  assert(memory.writes == 0U);
  assert(event_count == 3U && events[1] == 'A' && events[2] == 'N');
  assert(live.current_seen_at_announcement == 2U);

  memory.writable = false;
  assert(iterate_kit_provider_mode_adopt(
      &options, &store, &current, 1U, true, apply_mode, announce_mode, &live) ==
      ITERATE_KIT_PROVIDER_MODE_ADOPTION_PERSISTENCE_FAILED);
  assert(current == 1U && live.announced == 1U);
  memory.writable = true;

  assert(iterate_kit_provider_mode_adopt(
      &options, NULL, &current, 0U, true, apply_mode, announce_mode, &live) ==
      ITERATE_KIT_PROVIDER_MODE_ADOPTION_PERSISTENCE_FAILED);
  assert(current == 0U);

  assert(iterate_kit_provider_mode_adopt(
      &options, &store, &current, 2U, true, apply_mode, announce_mode, &live) ==
      ITERATE_KIT_PROVIDER_MODE_ADOPTION_APPLIED);
  assert(current == 2U && memory.value == 2U);
  assert(memory.writes == 2U);
  assert(live.announced == 2U && live.announcements == 4U);
  assert(event_count == 11U && events[8] == 'A' && events[9] == 'W' &&
      events[10] == 'N');
  assert(live.current_seen_at_announcement == 0U);

  assert(iterate_kit_provider_mode_adopt(
      &options, &store, &current, 4U, true, apply_mode, announce_mode, &live) ==
      ITERATE_KIT_PROVIDER_MODE_ADOPTION_INVALID);
  assert(current == 2U && live.applies == 5U && memory.writes == 2U);
  return 0;
}
