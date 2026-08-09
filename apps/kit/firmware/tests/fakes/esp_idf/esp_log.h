#ifndef ITERATE_KIT_FAKE_ESP_LOG_H
#define ITERATE_KIT_FAKE_ESP_LOG_H

/*
 * Host stand-in. See README.md in this directory.
 *
 * The arguments are still evaluated and still format-checked: a log line whose
 * specifiers do not match its arguments is a real defect, and losing that check
 * would make the host build weaker than the device build rather than the same
 * program somewhere cheaper. Silent by default so a passing test is quiet; set
 * ITERATE_KIT_FAKE_ESP_LOG=1 in the environment to see what a board would say.
 */

#include <stdio.h>

void iterate_kit_fake_esp_log(
    const char *level, const char *tag, const char *format, ...)
    __attribute__((format(printf, 3, 4)));

#define ESP_LOGE(tag, format, ...) \
  iterate_kit_fake_esp_log("E", (tag), format, ##__VA_ARGS__)
#define ESP_LOGW(tag, format, ...) \
  iterate_kit_fake_esp_log("W", (tag), format, ##__VA_ARGS__)
#define ESP_LOGI(tag, format, ...) \
  iterate_kit_fake_esp_log("I", (tag), format, ##__VA_ARGS__)
#define ESP_LOGD(tag, format, ...) \
  iterate_kit_fake_esp_log("D", (tag), format, ##__VA_ARGS__)
#define ESP_LOGV(tag, format, ...) \
  iterate_kit_fake_esp_log("V", (tag), format, ##__VA_ARGS__)

#endif
