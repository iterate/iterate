#ifndef ITERATE_KIT_TESTS_FAKE_ESP_LOG_H
#define ITERATE_KIT_TESTS_FAKE_ESP_LOG_H

/*
 * Recovery logging is verified through the transport's structured counters in
 * host tests. Suppressing the formatted serial side effect keeps tests quiet;
 * evaluating no arguments is intentional because logging must never carry
 * state transitions.
 */
#define ESP_LOGW(tag, format, ...) ((void)(tag))

#endif
