/* Translated from FutureProofHomes Satellite1-ESPHome satellite1/satellite1.cpp:118-212 (GPLv3), and Satellite1-XMOS device_control_spi.c:63-90 (XMOS PL). */
#include "iterate/kit/platforms/xmos_spi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>

/** Open the Satellite1-proven SPI2 transport, then poll a nonzero version.
 * Return the failed stage so the board retains its exact startup diagnostic.
 */
const char *iterate_kit_xmos_spi_open(struct iterate_kit_xmos_spi *handle,
    int mosi, int miso, int sclk, gpio_num_t cs,
    struct iterate_kit_xmos_version *version, uint8_t attempts, uint16_t interval_ms) {
  handle->cs_gpio = cs;
  const gpio_config_t cs_config = {
    .pin_bit_mask = UINT64_C(1) << cs,
    .mode = GPIO_MODE_OUTPUT,
    .pull_up_en = GPIO_PULLUP_DISABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  const spi_bus_config_t bus = {
    .mosi_io_num = mosi, .miso_io_num = miso, .sclk_io_num = sclk,
    .quadwp_io_num = -1, .quadhd_io_num = -1,
    .max_transfer_sz = 256,
  };
  const spi_device_interface_config_t device = {
    .clock_speed_hz = 8000000, .mode = 3, .spics_io_num = -1,
    .queue_size = 1, /* flags = 0: MSB first, full duplex; driver owns CS. */
  };
  const char *stage = "SPI CS";
  if (gpio_set_level(cs, 1) != ESP_OK ||
      gpio_config(&cs_config) != ESP_OK) goto failed;
  stage = "SPI bus";
  /* Every transaction here is at most 8 bytes; with DMA on, the driver copies
   * each stack buffer into internal DMA memory it mallocs per transaction,
   * twice per 25 ms poll, on a board that reserves that memory for Wi-Fi. */
  if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_DISABLED) != ESP_OK) goto failed;
  if (spi_bus_add_device(SPI2_HOST, &device, &handle->device) != ESP_OK) goto failed;
  stage = "XMOS version";
  if (!iterate_kit_xmos_spi_read_version(handle, version, attempts, interval_ms)) goto failed;
  return NULL;
failed:
  return stage;
}

static bool iterate_kit_xmos_spi_exchange(struct iterate_kit_xmos_spi *handle,
    const uint8_t *tx, uint8_t *rx, size_t length) {
  if (handle == NULL || handle->device == NULL || !GPIO_IS_VALID_OUTPUT_GPIO(handle->cs_gpio)) return false;
  for (unsigned int retry = 0; retry <= 3; ++retry) {
    /* Acquire before asserting our GPIO CS so another device cannot clock
     * into the XMOS while this polling transaction waits for the bus. */
    if (spi_device_acquire_bus(handle->device, portMAX_DELAY) != ESP_OK) return false;
    if (gpio_set_level(handle->cs_gpio, 0) != ESP_OK) {
      spi_device_release_bus(handle->device);
      return false;
    }
    spi_transaction_t transaction = {
      .length = length * 8, .rxlength = length * 8, .tx_buffer = tx, .rx_buffer = rx,
    };
    const esp_err_t result = spi_device_polling_transmit(handle->device, &transaction);
    const esp_err_t deselect = gpio_set_level(handle->cs_gpio, 1);
    spi_device_release_bus(handle->device);
    if (result != ESP_OK || deselect != ESP_OK) return false;
    if (rx[0] != 7) return true;
    if (retry < 3) vTaskDelay(1);
  }
  return false;
}

bool iterate_kit_xmos_spi_transfer(struct iterate_kit_xmos_spi *handle,
    uint8_t resource, uint8_t command, const uint8_t *payload, size_t len,
    uint8_t *reply, size_t reply_len) {
  const bool read = (command & 0x80U) != 0;
  if (read) {
    if (reply == NULL || reply_len == 0 || reply_len != len) return false;
  } else if (reply != NULL || reply_len != 0) return false;
  uint8_t tx[ITERATE_KIT_XMOS_SPI_FRAME_CAPACITY];
  uint8_t rx[ITERATE_KIT_XMOS_SPI_FRAME_CAPACITY];
  const size_t length = iterate_kit_xmos_spi_frame(tx, sizeof(tx), resource, command, payload, len);
  if (length == 0 || !iterate_kit_xmos_spi_exchange(handle, tx, rx, length)) return false;
  const enum iterate_kit_xmos_spi_reply kind = iterate_kit_xmos_spi_classify(rx, length, NULL);
  const bool payload_available = read && rx[0] == 1 && rx[1] == 23;
  /* The slave fills its TX buffer in the transfer-done callback
   * (device_control_spi.c:56-90), so a status report clocked in during THIS
   * transfer carries the PREVIOUS command's return code. It is not this
   * command's verdict: do not fail on it (the reference does not either). */
  if (kind != ITERATE_KIT_XMOS_SPI_STATUS_REPORT && kind != ITERATE_KIT_XMOS_SPI_OK &&
      !payload_available) return false;
  if (!read) return true;
  vTaskDelay(1);
  const size_t read_length = reply_len + 3;
  memset(tx, 0, read_length);
  if (!iterate_kit_xmos_spi_exchange(handle, tx, rx, read_length) || rx[0] != 0) return false;
  /* DONE plus an all-zero payload is valid data (e.g. pipeline NONE), not
   * the first-transfer NO_DEVICE shape. Version rejects zeros separately. */
  memcpy(reply, rx + 1, reply_len);
  return true;
}

bool iterate_kit_xmos_spi_read_version(struct iterate_kit_xmos_spi *handle,
    struct iterate_kit_xmos_version *version, uint8_t attempts, uint16_t interval_ms) {
  if (handle == NULL || version == NULL) return false;
  uint8_t command[3];
  if (iterate_kit_xmos_version_command(command, sizeof(command)) != ITERATE_KIT_OK) return false;
  const uint8_t dummy[5] = {0};
  /* A freshly booted slave answers the FIRST exchange with an all-zero
   * buffer, which classifies as NO_DEVICE; the reference primes with one dummy
   * byte in setup(). One NOP here so the first real attempt can succeed. */
  {
    uint8_t status[4];
    (void)iterate_kit_xmos_spi_read_status(handle, status);
  }
  for (unsigned int attempt = 0; attempt < attempts; ++attempt) {
    uint8_t payload[5];
    /* Shared resource/command; Satellite1 adds prerelease and n to the
     * three-part version, so its read length is five, not the I2C four. */
    if (iterate_kit_xmos_spi_transfer(handle, command[0], command[1], dummy, sizeof(dummy),
            payload, sizeof(payload)) &&
        iterate_kit_xmos_spi_parse_version(payload, sizeof(payload), version)) return true;
    if (attempt + 1 < attempts) vTaskDelay(pdMS_TO_TICKS(interval_ms));
  }
  return false;
}

bool iterate_kit_xmos_spi_read_status(struct iterate_kit_xmos_spi *handle, uint8_t status[4]) {
  if (status == NULL) return false;
  uint8_t tx[7], rx[7];
  const size_t length = iterate_kit_xmos_spi_frame(tx, sizeof(tx), 0, 0, NULL, 0);
  if (!iterate_kit_xmos_spi_exchange(handle, tx, rx, length)) return false;
  return iterate_kit_xmos_spi_classify(rx, length, status) == ITERATE_KIT_XMOS_SPI_STATUS_REPORT;
}
