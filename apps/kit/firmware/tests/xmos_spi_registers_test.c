#include "iterate/kit/platforms/xmos_spi_registers.h"
#include <assert.h>
#include <string.h>

static void iterate_kit_xmos_spi_test_frames(void) {
  uint8_t out[256];
  uint8_t command[4];
  assert(iterate_kit_xmos_pipeline_command(0, ITERATE_KIT_XMOS_STAGE_NS,
      command, sizeof(command)) == ITERATE_KIT_OK);
  assert(iterate_kit_xmos_spi_frame(out, sizeof(out), command[0], command[1], command + 3, 1) == 7);
  const uint8_t expected_write[] = {241, 0x30, 1, 3, 0, 0, 0};
  assert(memcmp(out, expected_write, sizeof(expected_write)) == 0);
  const uint8_t dummy[5] = {0};
  assert(iterate_kit_xmos_spi_frame(out, sizeof(out), 240, 0xD8, dummy, 5) == 8);
  const uint8_t expected_read[] = {240, 0xD8, 6, 0, 0, 0, 0, 0};
  assert(memcmp(out, expected_read, sizeof(expected_read)) == 0);
  assert(iterate_kit_xmos_spi_frame(out, sizeof(out), 241, 0x80, dummy, 1) == 7);
  const uint8_t expected_short_read[] = {241, 0x80, 2, 0, 0, 0, 0};
  assert(memcmp(out, expected_short_read, sizeof(expected_short_read)) == 0);
  assert(iterate_kit_xmos_spi_frame(out, sizeof(out), 0, 0, NULL, 0) == 7);
  const uint8_t expected_nop[7] = {0};
  assert(memcmp(out, expected_nop, sizeof(expected_nop)) == 0);
  uint8_t payload[254];
  memset(payload, 0xA5, sizeof(payload));
  assert(iterate_kit_xmos_spi_frame(out, sizeof(out), 1, 0x80, payload, 253) == 256);
  assert(out[2] == 254 && out[255] == 0xA5);
  memset(out, 0xCC, sizeof(out));
  assert(iterate_kit_xmos_spi_frame(out, sizeof(out), 1, 0, payload, 254) == 0);
  assert(iterate_kit_xmos_spi_frame(out, 6, 0, 0, NULL, 0) == 0);
  assert(iterate_kit_xmos_spi_frame(out, sizeof(out), 0, 0, NULL, 1) == 0);
  assert(iterate_kit_xmos_spi_frame(out, sizeof(out), 0, 0, payload, SIZE_MAX) == 0);
  assert(iterate_kit_xmos_spi_frame(NULL, sizeof(out), 0, 0, NULL, 0) == 0);
  for (size_t i = 0; i < sizeof(out); ++i) assert(out[i] == 0xCC);
}

static void iterate_kit_xmos_spi_test_replies(void) {
  const uint8_t rows[][7] = {
    {7, 0, 0, 0, 0, 0, 0}, {0, 0, 0, 1, 2, 3, 4},
    {1, 0, 0xA0, 0xA1, 0xA2, 0xA3, 0}, {0, 1, 0, 0, 0, 0, 0},
    {2, 0, 0, 0, 0, 0, 0}, {1, 23, 1, 2, 3, 4, 0},
    {1, 9, 1, 2, 3, 4, 0},
    /* A sum of 256 is not the all-zero NO_DEVICE shape. */
    {0, 255, 1, 0, 0, 0, 0},
  };
  const enum iterate_kit_xmos_spi_reply expected[] = {
    ITERATE_KIT_XMOS_SPI_BUSY, ITERATE_KIT_XMOS_SPI_NO_DEVICE,
    ITERATE_KIT_XMOS_SPI_STATUS_REPORT, ITERATE_KIT_XMOS_SPI_OK,
    ITERATE_KIT_XMOS_SPI_ERROR, ITERATE_KIT_XMOS_SPI_ERROR,
    ITERATE_KIT_XMOS_SPI_STATUS_REPORT, ITERATE_KIT_XMOS_SPI_OK,
  };
  for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); ++i) {
    uint8_t status[4] = {0xCC, 0xCC, 0xCC, 0xCC};
    assert(iterate_kit_xmos_spi_classify(rows[i], sizeof(rows[i]), status) == expected[i]);
    if (expected[i] == ITERATE_KIT_XMOS_SPI_STATUS_REPORT) {
      assert(memcmp(status, rows[i] + 2, sizeof(status)) == 0);
    } else {
      for (size_t j = 0; j < sizeof(status); ++j) assert(status[j] == 0xCC);
    }
  }
  assert(iterate_kit_xmos_spi_classify(NULL, 7, NULL) == ITERATE_KIT_XMOS_SPI_ERROR);
  assert(iterate_kit_xmos_spi_classify(rows[0], 2, NULL) == ITERATE_KIT_XMOS_SPI_ERROR);
  uint8_t status[4] = {9, 9, 9, 9};
  assert(iterate_kit_xmos_spi_classify(rows[2], 5, status) == ITERATE_KIT_XMOS_SPI_ERROR);
  for (size_t i = 0; i < sizeof(status); ++i) assert(status[i] == 9);
  assert(iterate_kit_xmos_spi_classify(rows[2], 6, NULL) == ITERATE_KIT_XMOS_SPI_STATUS_REPORT);
}

static void iterate_kit_xmos_spi_test_version(void) {
  const uint8_t payloads[][5] = {{1, 2, 3, 0, 0}, {0, 0, 0, 1, 0}, {0, 0, 0, 0, 1}};
  struct iterate_kit_xmos_version version;
  for (size_t i = 0; i < sizeof(payloads) / sizeof(payloads[0]); ++i) {
    assert(iterate_kit_xmos_spi_parse_version(payloads[i], 5, &version));
    assert(version.major == payloads[i][0]);
    assert(version.minor == payloads[i][1]);
    assert(version.patch == payloads[i][2]);
  }
  version = (struct iterate_kit_xmos_version){9, 9, 9};
  const uint8_t zeros[5] = {0};
  assert(!iterate_kit_xmos_spi_parse_version(zeros, 5, &version));
  assert(!iterate_kit_xmos_spi_parse_version(payloads[0], 4, &version));
  assert(!iterate_kit_xmos_spi_parse_version(payloads[0], 6, &version));
  assert(!iterate_kit_xmos_spi_parse_version(NULL, 5, &version));
  assert(!iterate_kit_xmos_spi_parse_version(payloads[0], 5, NULL));
  assert(version.major == 9 && version.minor == 9 && version.patch == 9);
}

int main(void) {
  iterate_kit_xmos_spi_test_frames();
  iterate_kit_xmos_spi_test_replies();
  iterate_kit_xmos_spi_test_version();
  return 0;
}
