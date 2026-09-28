#ifndef ITERATE_KIT_TEST_ESP_CRT_BUNDLE_H
#define ITERATE_KIT_TEST_ESP_CRT_BUNDLE_H
#include "esp_err.h"
/** The fake only checks that a wss:// stream attaches the bundle. */
esp_err_t esp_crt_bundle_attach(void *conf);
#endif
