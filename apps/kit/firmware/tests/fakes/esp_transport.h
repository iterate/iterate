#ifndef ITERATE_KIT_TESTS_FAKE_ESP_TRANSPORT_H
#define ITERATE_KIT_TESTS_FAKE_ESP_TRANSPORT_H

/*
 * The PCM transport retains ESP-IDF's lower transport only through the
 * WebSocket adapter. Its host test replaces that adapter as a whole, so an
 * opaque handle is the complete ABI needed here. Modelling TCP/TLS beneath the
 * fake would make the generation-race test depend on a second networking
 * implementation without increasing confidence in the production policy.
 */
typedef void *esp_transport_handle_t;

#endif
