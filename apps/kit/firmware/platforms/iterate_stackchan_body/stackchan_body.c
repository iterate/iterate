#include "iterate/kit/platforms/stackchan_body.h"

/*
 * ESP-IDF intentionally uses empty capability structs when a selected SoC has
 * no fields for an option. ISO C99 rejects those extensions, so isolate the
 * SDK boundary while retaining pedantic diagnostics for all code below it.
 */
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#endif
#include "bsp/m5stack_core_s3.h"
#include "driver/i2c_master.h"
#include "driver/uart.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

#include <stddef.h>
#include <stdint.h>
#include <string.h>

/*
 * These registers and pins are the public wire contract implemented by
 * M5Stack's MIT-licensed PY32IOExpander and StackChan SCS0009 drivers. Keeping
 * the tiny protocol here removes two Arduino object graphs while retaining a
 * byte-for-byte recognizable hardware boundary.
 */
#define STACKCHAN_BODY_I2C_ADDRESS 0x6fU
#define STACKCHAN_BODY_I2C_HZ 100000U
#define STACKCHAN_BODY_I2C_TIMEOUT_MS 200U
#define STACKCHAN_BODY_BOOT_PROBE_ATTEMPTS 6U
#define STACKCHAN_BODY_BOOT_PROBE_INTERVAL_MS 200U
#define PY32_REG_VERSION 0x02U
#define PY32_REG_GPIO_MODE_L 0x03U
#define PY32_REG_GPIO_MODE_H 0x04U
#define PY32_REG_GPIO_OUTPUT_L 0x05U
#define PY32_REG_GPIO_PULL_UP_L 0x09U
#define PY32_REG_GPIO_PULL_UP_H 0x0aU
#define PY32_REG_GPIO_PULL_DOWN_L 0x0bU
#define PY32_REG_GPIO_PULL_DOWN_H 0x0cU
#define PY32_REG_GPIO_DRIVE_H 0x14U
#define PY32_REG_LED_CONFIG 0x24U
#define PY32_REG_LED_RAM_START 0x30U
#define PY32_SERVO_POWER_BIT (1U << 0U)
#define PY32_LED_PIN_H_BIT (1U << (13U - 8U))
#define PY32_LED_REFRESH_BIT (1U << 6U)

#define STACKCHAN_SERVO_UART UART_NUM_1
#define STACKCHAN_SERVO_RX_PIN 7
#define STACKCHAN_SERVO_TX_PIN 6
#define STACKCHAN_SERVO_BAUD 1000000
/*
 * The first-party FTServo transport waits up to 100 ms for TX completion.
 * Although 22 bytes occupy only ~220 us at 1 Mbaud, ESP-IDF's completion API
 * waits on a task/ISR semaphore rather than merely calculating wire time. A
 * five-millisecond deadline failed on the physical CoreS3 under ordinary Wi-Fi
 * and display load even though the UART accepted the complete packet. Servo
 * tools are infrequent control-plane actions and never run on an audio owner,
 * so matching the audited first-party bound is safer than turning scheduler
 * latency into a false hardware fault. Timeout remains finite and observable.
 */
#define STACKCHAN_SERVO_TX_TIMEOUT_MS 100U
#define STACKCHAN_SERVO_RX_BUFFER_BYTES \
  (UART_HW_FIFO_LEN(STACKCHAN_SERVO_UART) + 1U)
#define STACKCHAN_SERVO_SYNC_WRITE 0x83U
#define STACKCHAN_SERVO_GOAL_POSITION 42U
#define STACKCHAN_SERVO_BYTES_PER_ID 6U
#define STACKCHAN_SERVO_BROADCAST_ID 0xfeU
#define STACKCHAN_SERVO_YAW_ID 1U
#define STACKCHAN_SERVO_PITCH_ID 2U
#define STACKCHAN_SERVO_YAW_ZERO_RAW 460
#define STACKCHAN_SERVO_PITCH_ZERO_RAW 620
#define STACKCHAN_SERVO_PACKET_BYTES 22U

static const char *const TAG = "iterate-stackchan-body";

/*
 * ESP-IDF's ESP_RETURN_ON_ERROR expands to the non-standard `__FUNCTION__`
 * identifier. This component intentionally compiles as strict C99 with
 * pedantic warnings promoted to errors, so retain the useful bounded early
 * return while logging through the standard call-site message instead.
 */
#define BODY_RETURN_ON_ERROR(expression, tag, message)                 \
  do {                                                                 \
    const esp_err_t body_result__ = (expression);                      \
    if (body_result__ != ESP_OK) {                                     \
      ESP_LOGE((tag), "%s: %s", (message), esp_err_to_name(body_result__)); \
      return body_result__;                                            \
    }                                                                  \
  } while (0)

static i2c_master_dev_handle_t body_i2c(
    const struct iterate_kit_stackchan_body *body) {
  return (i2c_master_dev_handle_t)body->i2c_device;
}

static esp_err_t read_register(
    const struct iterate_kit_stackchan_body *body,
    uint8_t address,
    uint8_t *value) {
  return i2c_master_transmit_receive(
      body_i2c(body),
      &address,
      sizeof(address),
      value,
      sizeof(*value),
      pdMS_TO_TICKS(STACKCHAN_BODY_I2C_TIMEOUT_MS));
}

static esp_err_t write_register(
    const struct iterate_kit_stackchan_body *body,
    uint8_t address,
    uint8_t value) {
  const uint8_t command[] = {address, value};
  return i2c_master_transmit(
      body_i2c(body),
      command,
      sizeof(command),
      pdMS_TO_TICKS(STACKCHAN_BODY_I2C_TIMEOUT_MS));
}

static esp_err_t update_register(
    const struct iterate_kit_stackchan_body *body,
    uint8_t address,
    uint8_t set_bits,
    uint8_t clear_bits) {
  uint8_t value = 0U;
  BODY_RETURN_ON_ERROR(
      read_register(body, address, &value), TAG, "read body register");
  value = (uint8_t)((value | set_bits) & (uint8_t)~clear_bits);
  return write_register(body, address, value);
}

static enum iterate_kit_status write_leds(
    void *context,
    const uint16_t *pixels,
    size_t pixel_count) {
  struct iterate_kit_stackchan_body *body = context;
  uint8_t command[1U + ITERATE_KIT_STACKCHAN_LED_COUNT * 2U];
  if (body == NULL || !body->i2c_ready || pixels == NULL ||
      pixel_count != ITERATE_KIT_STACKCHAN_LED_COUNT) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  command[0] = PY32_REG_LED_RAM_START;
  for (size_t index = 0U; index < pixel_count; ++index) {
    /* The body RAM stores each ordinary RGB565 word least-significant byte first. */
    command[1U + index * 2U] = (uint8_t)(pixels[index] & 0xffU);
    command[2U + index * 2U] = (uint8_t)(pixels[index] >> 8U);
  }
  if (i2c_master_transmit(
          body_i2c(body),
          command,
          sizeof(command),
          pdMS_TO_TICKS(STACKCHAN_BODY_I2C_TIMEOUT_MS)) != ESP_OK ||
      write_register(
          body,
          PY32_REG_LED_CONFIG,
          (uint8_t)(ITERATE_KIT_STACKCHAN_LED_COUNT |
                    PY32_LED_REFRESH_BIT)) != ESP_OK) {
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

static uint16_t servo_position(int16_t degrees, int32_t zero_raw) {
  /*
   * M5Stack calibrates these two installed servos independently: raw 460 is
   * forward yaw and raw 620 is level pitch. One raw step is 0.3125 degrees,
   * hence raw = zero + degrees * 16 / 5. This is intentionally not the generic
   * 0..300-degree SCS0009 catalogue mapping: enclosure linkage and servo horn
   * installation define the useful coordinate, and using catalogue travel can
   * command the head into its mechanical stops.
   */
  const int32_t raw = zero_raw + ((int32_t)degrees * 16) / 5;
  return (uint16_t)raw;
}

static void append_servo(
    uint8_t *packet,
    size_t offset,
    uint8_t id,
    int16_t degrees,
    int32_t zero_raw,
    uint16_t duration_ms) {
  const uint16_t position = servo_position(degrees, zero_raw);
  packet[offset] = id;
  packet[offset + 1U] = (uint8_t)(position >> 8U);
  packet[offset + 2U] = (uint8_t)(position & 0xffU);
  packet[offset + 3U] = (uint8_t)(duration_ms >> 8U);
  packet[offset + 4U] = (uint8_t)(duration_ms & 0xffU);
  packet[offset + 5U] = 0U;
  packet[offset + 6U] = 0U;
}

static enum iterate_kit_status move_head(
    void *context,
    int16_t yaw_degrees,
    int16_t pitch_degrees,
    uint16_t duration_ms) {
  struct iterate_kit_stackchan_body *body = context;
  uint8_t packet[STACKCHAN_SERVO_PACKET_BYTES] = {
      0xffU,
      0xffU,
      STACKCHAN_SERVO_BROADCAST_ID,
      18U,
      STACKCHAN_SERVO_SYNC_WRITE,
      STACKCHAN_SERVO_GOAL_POSITION,
      STACKCHAN_SERVO_BYTES_PER_ID,
  };
  uint8_t checksum = 0U;
  if (body == NULL || !body->servo_ready ||
      yaw_degrees < -128 || yaw_degrees > 128 ||
      pitch_degrees < 0 || pitch_degrees > 90) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  append_servo(
      packet,
      7U,
      STACKCHAN_SERVO_YAW_ID,
      yaw_degrees,
      STACKCHAN_SERVO_YAW_ZERO_RAW,
      duration_ms);
  append_servo(
      packet,
      14U,
      STACKCHAN_SERVO_PITCH_ID,
      pitch_degrees,
      STACKCHAN_SERVO_PITCH_ZERO_RAW,
      duration_ms);
  for (size_t index = 2U; index < STACKCHAN_SERVO_PACKET_BYTES - 1U;
       ++index) {
    checksum = (uint8_t)(checksum + packet[index]);
  }
  packet[STACKCHAN_SERVO_PACKET_BYTES - 1U] = (uint8_t)~checksum;

  /*
   * A broadcast sync-write deliberately has no response. The UART driver owns
   * the short copy and the two servos execute the timed move themselves, so a
   * 700 ms gesture never parks the control loop or steals time from audio.
   */
  const int written = uart_write_bytes(
      STACKCHAN_SERVO_UART, packet, sizeof(packet));
  if (written != (int)sizeof(packet)) {
    ESP_LOGE(TAG,
             "servo UART short write: written=%d expected=%u",
             written,
             (unsigned int)sizeof(packet));
    return ITERATE_KIT_IO_ERROR;
  }
  const esp_err_t completion = uart_wait_tx_done(
      STACKCHAN_SERVO_UART,
      pdMS_TO_TICKS(STACKCHAN_SERVO_TX_TIMEOUT_MS));
  if (completion != ESP_OK) {
    /* Preserve attribution instead of collapsing every servo fault to RPC I/O. */
    ESP_LOGE(TAG,
             "servo UART completion failed: %s",
             esp_err_to_name(completion));
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

esp_err_t iterate_kit_stackchan_body_start(
    struct iterate_kit_stackchan_body *body) {
  i2c_master_bus_handle_t bus = NULL;
  uint8_t version = 0U;
  esp_err_t result = ESP_FAIL;
  if (body == NULL) return ESP_ERR_INVALID_ARG;
  memset(body, 0, sizeof(*body));

  BODY_RETURN_ON_ERROR(bsp_i2c_init(), TAG, "initialize CoreS3 I2C");
  /*
   * The PY32 is physically downstream of CoreS3's switched M-BUS rail.  Make
   * the board BSP prove BUS_OUT_EN + BOOST_EN before asking the module driver
   * to distinguish a booting body from an absent one.  M5Stack's own
   * M5Unified StackChan path performs this same operation before its bounded
   * 0x6f probe loop.
   */
  BODY_RETURN_ON_ERROR(
      bsp_external_power_enable(), TAG, "enable CoreS3 external power");
  BODY_RETURN_ON_ERROR(
      i2c_master_get_bus_handle(BSP_I2C_NUM, &bus),
      TAG,
      "get CoreS3 I2C bus");
  for (uint32_t attempt = 0U;
       attempt < STACKCHAN_BODY_BOOT_PROBE_ATTEMPTS;
       ++attempt) {
    result = i2c_master_probe(
        bus,
        STACKCHAN_BODY_I2C_ADDRESS,
        pdMS_TO_TICKS(STACKCHAN_BODY_I2C_TIMEOUT_MS));
    if (result == ESP_OK) break;
    vTaskDelay(pdMS_TO_TICKS(STACKCHAN_BODY_BOOT_PROBE_INTERVAL_MS));
  }
  BODY_RETURN_ON_ERROR(result, TAG, "probe StackChan body");

  const i2c_device_config_t device_config = {
      .dev_addr_length = I2C_ADDR_BIT_LEN_7,
      .device_address = STACKCHAN_BODY_I2C_ADDRESS,
      .scl_speed_hz = STACKCHAN_BODY_I2C_HZ,
  };
  i2c_master_dev_handle_t device = NULL;
  BODY_RETURN_ON_ERROR(
      i2c_master_bus_add_device(bus, &device_config, &device),
      TAG,
      "attach StackChan body");
  body->i2c_device = device;
  BODY_RETURN_ON_ERROR(
      read_register(body, PY32_REG_VERSION, &version),
      TAG,
      "read StackChan body version");
  if (version == 0U || version == 0xffU) return ESP_ERR_INVALID_RESPONSE;

  BODY_RETURN_ON_ERROR(
      update_register(body, PY32_REG_GPIO_MODE_H, PY32_LED_PIN_H_BIT, 0U),
      TAG,
      "set body LED output");
  BODY_RETURN_ON_ERROR(
      update_register(body, PY32_REG_GPIO_PULL_DOWN_H, 0U, PY32_LED_PIN_H_BIT),
      TAG,
      "disable body LED pull-down");
  BODY_RETURN_ON_ERROR(
      update_register(body, PY32_REG_GPIO_PULL_UP_H, PY32_LED_PIN_H_BIT, 0U),
      TAG,
      "enable body LED pull-up");
  BODY_RETURN_ON_ERROR(
      update_register(body, PY32_REG_GPIO_DRIVE_H, 0U, PY32_LED_PIN_H_BIT),
      TAG,
      "set body LED push-pull");
  BODY_RETURN_ON_ERROR(
      write_register(
          body, PY32_REG_LED_CONFIG, ITERATE_KIT_STACKCHAN_LED_COUNT),
      TAG,
      "configure body LED count");

  /* Pin zero gates power to both serial servos on the official body. */
  BODY_RETURN_ON_ERROR(
      update_register(body, PY32_REG_GPIO_MODE_L, PY32_SERVO_POWER_BIT, 0U),
      TAG,
      "set servo power output");
  BODY_RETURN_ON_ERROR(
      update_register(body, PY32_REG_GPIO_PULL_DOWN_L, 0U, PY32_SERVO_POWER_BIT),
      TAG,
      "disable servo power pull-down");
  BODY_RETURN_ON_ERROR(
      update_register(body, PY32_REG_GPIO_PULL_UP_L, PY32_SERVO_POWER_BIT, 0U),
      TAG,
      "enable servo power pull-up");
  BODY_RETURN_ON_ERROR(
      update_register(body, PY32_REG_GPIO_OUTPUT_L, PY32_SERVO_POWER_BIT, 0U),
      TAG,
      "enable servo power");
  vTaskDelay(pdMS_TO_TICKS(200U));

  const uart_config_t uart_config = {
      .baud_rate = STACKCHAN_SERVO_BAUD,
      .data_bits = UART_DATA_8_BITS,
      .parity = UART_PARITY_DISABLE,
      .stop_bits = UART_STOP_BITS_1,
      .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
      .source_clk = UART_SCLK_DEFAULT,
  };
  BODY_RETURN_ON_ERROR(
      /*
       * ESP-IDF 5.4 requires an RX ring strictly larger than the hardware FIFO
       * even when the application only issues broadcast writes.  Allocate the
       * minimum legal ring rather than importing the first-party driver's two
       * larger generic buffers.  The servos do not reply to sync-write, so no
       * receive task or queue is needed and an unexpected byte cannot block
       * the control loop or the audio owner.
       */
      uart_driver_install(
          STACKCHAN_SERVO_UART,
          STACKCHAN_SERVO_RX_BUFFER_BYTES,
          0,
          0,
          NULL,
          0),
      TAG,
      "install servo UART");
  BODY_RETURN_ON_ERROR(
      uart_param_config(STACKCHAN_SERVO_UART, &uart_config),
      TAG,
      "configure servo UART");
  BODY_RETURN_ON_ERROR(
      uart_set_pin(
          STACKCHAN_SERVO_UART,
          STACKCHAN_SERVO_TX_PIN,
          STACKCHAN_SERVO_RX_PIN,
          UART_PIN_NO_CHANGE,
          UART_PIN_NO_CHANGE),
      TAG,
      "route servo UART");

  body->i2c_ready = true;
  body->servo_ready = true;
  const uint16_t clear[ITERATE_KIT_STACKCHAN_LED_COUNT] = {0};
  if (write_leds(body, clear, ITERATE_KIT_STACKCHAN_LED_COUNT) !=
      ITERATE_KIT_OK) {
    return ESP_FAIL;
  }
  ESP_LOGI(TAG, "body ready: version=0x%02x leds=12 servos=2", version);
  return ESP_OK;
}

struct iterate_kit_stackchan_hardware_ops
iterate_kit_stackchan_body_hardware_ops(
    struct iterate_kit_stackchan_body *body) {
  const struct iterate_kit_stackchan_hardware_ops ops = {
      .context = body,
      .write_leds = write_leds,
      .move_head = move_head,
  };
  return ops;
}
