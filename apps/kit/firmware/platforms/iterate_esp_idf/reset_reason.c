#include "iterate/kit/platforms/esp_idf_reset_reason.h"

#include "esp_system.h"

const char *iterate_kit_esp_reset_reason_name(void) {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:
      return "poweron";
    case ESP_RST_EXT:
      return "external";
    case ESP_RST_SW:
      /* esp_restart(): ours, and deliberate — the liveness restart path. */
      return "software";
    case ESP_RST_PANIC:
      /* A crash. The one that must never be confused with the others. */
      return "panic";
    case ESP_RST_INT_WDT:
      return "interrupt-watchdog";
    case ESP_RST_TASK_WDT:
      /* A task stopped feeding the watchdog: a stall, not a crash. */
      return "task-watchdog";
    case ESP_RST_WDT:
      return "watchdog";
    case ESP_RST_DEEPSLEEP:
      return "deepsleep";
    case ESP_RST_BROWNOUT:
      /* The supply sagged. On these boards that is the speaker at volume. */
      return "brownout";
    case ESP_RST_SDIO:
      return "sdio";
    case ESP_RST_USB:
      /* Opening the USB console resets these boards; this is that. */
      return "usb";
    case ESP_RST_JTAG:
      return "jtag";
    case ESP_RST_UNKNOWN:
    default:
      return "unknown";
  }
}
