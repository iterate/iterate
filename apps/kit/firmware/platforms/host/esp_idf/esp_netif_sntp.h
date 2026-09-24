#ifndef ITERATE_KIT_HOST_ESP_NETIF_SNTP_H
#define ITERATE_KIT_HOST_ESP_NETIF_SNTP_H

/* Host stand-in. See esp_idf.h. */

#include "esp_err.h"
#include "esp_netif.h"

typedef struct {
  const char *server;
} esp_sntp_config_t;

#define ESP_NETIF_SNTP_DEFAULT_CONFIG(server_name) \
  { (server_name) }

esp_err_t esp_netif_sntp_init(const esp_sntp_config_t *config);

#endif
