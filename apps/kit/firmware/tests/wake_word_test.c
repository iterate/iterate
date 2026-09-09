#include "iterate/kit/platforms/wake_word.h"
#include <assert.h>
#include <string.h>

/** Recording consumer proves actual sample order, including frame crossings. */
struct iterate_kit_wake_word_test {
  size_t chunk;
  size_t consumed;
  size_t stop_after;
};

static bool iterate_kit_wake_word_test_consume(void *context, int16_t *samples) {
  struct iterate_kit_wake_word_test *test = context;
  for (size_t i = 0; i < test->chunk; ++i) assert(samples[i] == (int16_t)(test->consumed + i));
  test->consumed += test->chunk;
  return test->stop_after == 0U || test->consumed < test->stop_after;
}

static void iterate_kit_wake_word_test_chunks(void) {
  const struct {
    size_t chunk, slices[4], consumed, remaining, stop_after;
  } rows[] = {
    {512, {320, 320, 320, 320}, 1024, 256, 0},
    {160, {320, 320, 0, 0}, 640, 0, 0},
    {320, {319, 1, 0, 0}, 320, 0, 0},
    {512, {1, 511, 513, 7}, 1024, 8, 0},
    {480, {320, 320, 320, 0}, 960, 0, 0},
    {512, {320, 0, 0, 0}, 0, 320, 0},
    {1, {3, 0, 0, 0}, 3, 0, 0},
    {320, {960, 0, 0, 0}, 320, 0, 320},
    {512, {0, 0, 0, 0}, 0, 0, 0},
  };
  int16_t source[2048], scratch[512];
  for (size_t i = 0; i < 2048; ++i) source[i] = (int16_t)i;
  for (size_t r = 0; r < sizeof(rows) / sizeof(rows[0]); ++r) {
    struct iterate_kit_wake_word_buffer buffer = {scratch, rows[r].chunk, 0};
    struct iterate_kit_wake_word_test test = {rows[r].chunk, 0, rows[r].stop_after};
    size_t offset = 0;
    for (size_t s = 0; s < 4; ++s) {
      assert(iterate_kit_wake_word_buffer_feed(&buffer, source + offset,
          rows[r].slices[s], iterate_kit_wake_word_test_consume, &test));
      offset += rows[r].slices[s];
    }
    assert(test.consumed == rows[r].consumed);
    assert(buffer.used == rows[r].remaining);
    for (size_t i = 0; i < buffer.used; ++i) assert(scratch[i] == source[test.consumed + i]);
  }
  /* A pause discards an incomplete old word, never joins it to new capture. */
  struct iterate_kit_wake_word_buffer buffer = {scratch, 512, 0};
  struct iterate_kit_wake_word_test test = {512, 0, 0};
  assert(iterate_kit_wake_word_buffer_feed(&buffer, source, 319,
      iterate_kit_wake_word_test_consume, &test));
  buffer.used = 0;
  assert(iterate_kit_wake_word_buffer_feed(&buffer, source, 512,
      iterate_kit_wake_word_test_consume, &test));
  assert(test.consumed == 512 && buffer.used == 0);
}

static void iterate_kit_wake_word_test_invalid(void) {
  int16_t scratch[8] = {0};
  const struct { size_t capacity, used; bool valid; } rows[] = {
    {0, 0, false}, {8, 8, false}, {8, 9, false},
    {SIZE_MAX, 0, false}, {8, 0, true}, {8, 7, true},
  };
  for (size_t r = 0; r < sizeof(rows) / sizeof(rows[0]); ++r) {
    struct iterate_kit_wake_word_buffer buffer = {scratch, rows[r].capacity, rows[r].used};
    assert(iterate_kit_wake_word_buffer_feed(&buffer, NULL, 0,
        iterate_kit_wake_word_test_consume, NULL) == rows[r].valid);
    assert(buffer.used == rows[r].used);
    assert(!iterate_kit_wake_word_buffer_feed(&buffer, NULL, 1,
        iterate_kit_wake_word_test_consume, NULL));
    assert(!iterate_kit_wake_word_buffer_feed(&buffer, scratch, 1, NULL, NULL));
  }
  struct iterate_kit_wake_word_buffer buffer = {NULL, 8, 0};
  assert(!iterate_kit_wake_word_buffer_feed(&buffer, scratch, 1,
      iterate_kit_wake_word_test_consume, NULL));
  assert(!iterate_kit_wake_word_buffer_feed(NULL, scratch, 1,
      iterate_kit_wake_word_test_consume, NULL));
}

int main(void) {
  iterate_kit_wake_word_test_chunks();
  iterate_kit_wake_word_test_invalid();
  return 0;
}
