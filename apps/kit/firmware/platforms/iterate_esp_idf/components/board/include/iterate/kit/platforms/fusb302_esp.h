#ifndef ITERATE_KIT_FUSB302_ESP_H
#define ITERATE_KIT_FUSB302_ESP_H

#include "driver/i2c_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "iterate/kit/platforms/fusb302.h"

/* One instance per port. Only the private task touches the PHY; callers read
 * a copied status. The board owns its amplifier and reacts to power changes. */
struct iterate_kit_fusb302_esp {
  i2c_master_dev_handle_t device;
  struct iterate_kit_fusb302 controller;
  struct iterate_kit_pd_status published;
  portMUX_TYPE lock;
  TaskHandle_t task;
};

bool iterate_kit_fusb302_esp_start(struct iterate_kit_fusb302_esp *port,
    i2c_master_dev_handle_t device, struct iterate_kit_pd_limits limits);
struct iterate_kit_pd_status iterate_kit_fusb302_esp_status(struct iterate_kit_fusb302_esp *port);

#endif
