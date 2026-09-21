#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "iterate/kit/capabilities/screen.h"

bool note4_display_start(void);
bool note4_display_show(const char *title, const char *status);
uint32_t note4_display_updates(void);
uint32_t note4_display_failures(void);

bool note4_display_submit(void *context, enum iterate_kit_screen_format format,
                          const uint8_t *bytes, size_t length);
enum iterate_kit_screen_state note4_display_state(void *context);
