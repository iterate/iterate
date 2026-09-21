#include "iterate/kit/platforms/fusb302_esp.h"
#include "esp_log.h"
#include "esp_timer.h"

static bool read_register(void *context, uint8_t reg, uint8_t *out, size_t length) {
  struct iterate_kit_fusb302_esp *port = context;
  return i2c_master_transmit_receive(port->device, &reg, 1, out, length, 20) == ESP_OK;
}

static bool write_register(void *context, uint8_t reg, const uint8_t *in, size_t length) {
  struct iterate_kit_fusb302_esp *port = context;
  uint8_t bytes[40];
  if (length > sizeof(bytes) - 1) return false;
  bytes[0] = reg;
  for (size_t i = 0; i < length; ++i) bytes[i + 1] = in[i];
  return i2c_master_transmit(port->device, bytes, length + 1, 20) == ESP_OK;
}

static void run(void *context) {
  struct iterate_kit_fusb302_esp *port = context;
  enum iterate_kit_pd_state previous = port->published.state;
  for (;;) {
    iterate_kit_fusb302_poll(&port->controller, (uint64_t)(esp_timer_get_time() / 1000));
    const struct iterate_kit_pd_status status = port->controller.status;
    portENTER_CRITICAL(&port->lock);
    port->published = status;
    portEXIT_CRITICAL(&port->lock);
    if (status.state != previous) {
      ESP_LOGI("usb-pd", "state=%u failure=%u supply=%umV/%umA contracts=%lu",
          (unsigned)status.state, (unsigned)status.failure, status.millivolts,
          status.milliamps, (unsigned long)status.contracts);
      previous = status.state;
    }
    /* Failed is terminal until reboot: keep the reason, never hammer I2C. */
    const TickType_t ticks = pdMS_TO_TICKS(status.state == ITERATE_KIT_PD_FAILED ? 1000 : 2);
    vTaskDelay(ticks > 0 ? ticks : 1);
  }
}

bool iterate_kit_fusb302_esp_start(struct iterate_kit_fusb302_esp *port,
    i2c_master_dev_handle_t device, struct iterate_kit_pd_limits limits) {
  if (port == NULL || device == NULL) return false;
  *port = (struct iterate_kit_fusb302_esp){.device = device, .lock = portMUX_INITIALIZER_UNLOCKED};
  const struct iterate_kit_fusb302_io io = {
    .context = port, .read = read_register, .write = write_register,
  };
  const bool started = iterate_kit_fusb302_start(&port->controller, &io, limits,
      (uint64_t)(esp_timer_get_time() / 1000));
  port->published = port->controller.status;
  if (!started) return false;
  if (xTaskCreate(run, "usb-pd", 3072, port, 10, &port->task) == pdPASS) return true;
  port->published.state = ITERATE_KIT_PD_FAILED;
  port->published.failure = ITERATE_KIT_PD_FAILURE_TASK;
  return false;
}

struct iterate_kit_pd_status iterate_kit_fusb302_esp_status(struct iterate_kit_fusb302_esp *port) {
  portENTER_CRITICAL(&port->lock);
  const struct iterate_kit_pd_status status = port->published;
  portEXIT_CRITICAL(&port->lock);
  return status;
}
