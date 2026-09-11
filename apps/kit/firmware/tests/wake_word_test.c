#include "iterate/kit/platforms/wake_word.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

struct iterate_kit_wake_word_model_image {
  unsigned char bytes[256];
  size_t size;
};

struct iterate_kit_wake_word_model_file {
  FILE *file;
  size_t size;
};

static bool iterate_kit_wake_word_model_read(
    void *context, size_t offset, void *destination, size_t length) {
  const struct iterate_kit_wake_word_model_image *image = context;
  if (offset > image->size || length > image->size - offset) return false;
  memcpy(destination, image->bytes + offset, length);
  return true;
}

static bool iterate_kit_wake_word_model_read_failure(
    void *context, size_t offset, void *destination, size_t length) {
  (void)context;
  (void)offset;
  (void)destination;
  (void)length;
  return false;
}

static bool iterate_kit_wake_word_model_file_read(
    void *context, size_t offset, void *destination, size_t length) {
  struct iterate_kit_wake_word_model_file *file = context;
  return offset <= file->size && length <= file->size - offset &&
      fseek(file->file, (long)offset, SEEK_SET) == 0 &&
      fread(destination, 1U, length, file->file) == length;
}

static void iterate_kit_wake_word_model_u32(
    struct iterate_kit_wake_word_model_image *image, size_t offset, uint32_t value) {
  image->bytes[offset] = (unsigned char)value;
  image->bytes[offset + 1U] = (unsigned char)(value >> 8);
  image->bytes[offset + 2U] = (unsigned char)(value >> 16);
  image->bytes[offset + 3U] = (unsigned char)(value >> 24);
}

static void iterate_kit_wake_word_model_string(
    struct iterate_kit_wake_word_model_image *image, size_t offset, const char *value) {
  memcpy(image->bytes + offset, value, strlen(value));
}

static struct iterate_kit_wake_word_model_image iterate_kit_wake_word_valid_model(void) {
  struct iterate_kit_wake_word_model_image image = {.size = 163U};
  iterate_kit_wake_word_model_u32(&image, 0U, 1U);
  iterate_kit_wake_word_model_string(&image, 4U, "wn9_jarvis_tts");
  iterate_kit_wake_word_model_u32(&image, 36U, 3U);
  const char *names[] = {"wn9_data", "wn9_index", "_MODEL_INFO_"};
  for (size_t i = 0; i < 3U; ++i) {
    const size_t record = 40U + i * 40U;
    iterate_kit_wake_word_model_string(&image, record, names[i]);
    iterate_kit_wake_word_model_u32(&image, record + 32U, 160U + i);
    iterate_kit_wake_word_model_u32(&image, record + 36U, 1U);
  }
  return image;
}

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

static void iterate_kit_wake_word_test_model_partition(void) {
  struct iterate_kit_wake_word_model_image image = iterate_kit_wake_word_valid_model();
  assert(iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));

  image.size = 3U; /* Count itself is truncated. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  iterate_kit_wake_word_model_u32(&image, 0U, UINT32_MAX); /* Unbounded parser allocation. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  image.size = 39U; /* Partial model header. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  image.size = 79U; /* Partial file header. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  image.bytes[40U] = 'x'; image.bytes[41U] = 'x'; image.bytes[42U] = 'x';
  image.bytes[43U] = 'x'; image.bytes[44U] = 'x'; image.bytes[45U] = 'x';
  image.bytes[46U] = 'x'; image.bytes[47U] = 'x'; /* Target data is missing. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  iterate_kit_wake_word_model_u32(&image, 72U, 159U); /* Points into header. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  iterate_kit_wake_word_model_u32(&image, 112U, UINT32_MAX); /* File starts after flash. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  iterate_kit_wake_word_model_u32(&image, 116U, UINT32_MAX); /* File length overflows flash. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  memset(image.bytes + 40U, 'x', 32U); /* esp-sr strcmp needs a terminator. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  iterate_kit_wake_word_model_string(&image, 80U, "wn9_data"); /* Duplicate required file. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  iterate_kit_wake_word_model_u32(&image, 156U, 4097U); /* Loader copies metadata. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      UINT32_MAX, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  image = iterate_kit_wake_word_valid_model();
  image.size = 196U;
  iterate_kit_wake_word_model_u32(&image, 0U, 2U);
  iterate_kit_wake_word_model_string(&image, 160U, "wn9_jarvis_tts");
  iterate_kit_wake_word_model_u32(&image, 192U, 1U); /* Duplicate model name. */
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read, &image, "wn9_jarvis_tts"));
  assert(!iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_read_failure, &image, "wn9_jarvis_tts"));
  unsigned char blank[4] = {0};
  struct iterate_kit_wake_word_model_image empty = {.size = sizeof(blank)};
  memcpy(empty.bytes, blank, sizeof(blank));
  assert(!iterate_kit_wake_word_model_partition_valid(
      empty.size, iterate_kit_wake_word_model_read, &empty, "wn9_jarvis_tts"));
}

static void iterate_kit_wake_word_test_generated_model_partition(void) {
  const char test_suffix[] = "/tests/wake_word_test.c";
  const char generated_suffix[] = "/targets/satellite1/build/srmodels/srmodels.bin";
  const char *test_path = strstr(__FILE__, test_suffix);
  if (test_path == NULL) return; /* Relative compiler paths cannot locate a build artifact. */
  char path[1024];
  const size_t prefix = (size_t)(test_path - __FILE__);
  assert(prefix + sizeof(generated_suffix) <= sizeof(path));
  memcpy(path, __FILE__, prefix);
  memcpy(path + prefix, generated_suffix, sizeof(generated_suffix));
  FILE *file = fopen(path, "rb");
  if (file == NULL) return; /* Host CI does not materialize target build outputs. */
  assert(fseek(file, 0L, SEEK_END) == 0);
  const long length = ftell(file);
  assert(length > 0L);
  rewind(file);
  struct iterate_kit_wake_word_model_file image = {file, (size_t)length};
  assert(iterate_kit_wake_word_model_partition_valid(
      image.size, iterate_kit_wake_word_model_file_read, &image, "wn9_jarvis_tts"));
  assert(fclose(file) == 0);
}

int main(void) {
  iterate_kit_wake_word_test_chunks();
  iterate_kit_wake_word_test_invalid();
  iterate_kit_wake_word_test_model_partition();
  iterate_kit_wake_word_test_generated_model_partition();
  return 0;
}
