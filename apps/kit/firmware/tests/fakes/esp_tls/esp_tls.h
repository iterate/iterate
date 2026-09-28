#ifndef ITERATE_KIT_TEST_ESP_TLS_H
#define ITERATE_KIT_TEST_ESP_TLS_H

/*
 * ESP-TLS as the board's byte stream calls it, scripted (fake_esp_tls.h).
 * The types and values are ESP-IDF v6.1's (components/esp-tls/esp_tls.h and
 * esp_tls_errors.h); only what the stream touches is here.
 */

#include "esp_err.h"

#include <stdbool.h>
#include <stddef.h>
#include <sys/types.h>

#define ESP_TLS_ERR_SSL_WANT_READ (-0x6900)
#define ESP_TLS_ERR_SSL_WANT_WRITE (-0x6880)
#define ESP_TLS_ERR_SSL_TIMEOUT (-0x6800)

#define ESP_ERR_ESP_TLS_BASE 0x8000
#define ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME (ESP_ERR_ESP_TLS_BASE + 0x01)
#define ESP_ERR_MBEDTLS_SSL_READ_FAILED (ESP_ERR_ESP_TLS_BASE + 0x1D)
#define ESP_ERR_MBEDTLS_SSL_WRITE_FAILED (ESP_ERR_ESP_TLS_BASE + 0x18)

typedef enum {
  ESP_TLS_ERR_TYPE_UNKNOWN = 0,
  ESP_TLS_ERR_TYPE_SYSTEM,
  ESP_TLS_ERR_TYPE_MBEDTLS,
  ESP_TLS_ERR_TYPE_MBEDTLS_CERT_FLAGS,
  ESP_TLS_ERR_TYPE_ESP,
  ESP_TLS_ERR_TYPE_MAX,
} esp_tls_error_type_t;

typedef struct esp_tls_last_error *esp_tls_error_handle_t;

typedef struct tls_keep_alive_cfg {
  bool keep_alive_enable;
  int keep_alive_idle;
  int keep_alive_interval;
  int keep_alive_count;
} tls_keep_alive_cfg_t;

typedef struct esp_tls_cfg {
  int timeout_ms;
  tls_keep_alive_cfg_t *keep_alive_cfg;
  esp_err_t (*crt_bundle_attach)(void *conf);
  bool is_plain_tcp;
} esp_tls_cfg_t;

typedef struct esp_tls esp_tls_t;

esp_tls_t *esp_tls_init(void);
int esp_tls_conn_new_sync(const char *hostname, int hostlen, int port,
    const esp_tls_cfg_t *cfg, esp_tls_t *tls);
ssize_t esp_tls_conn_read(esp_tls_t *tls, void *data, size_t datalen);
ssize_t esp_tls_conn_write(esp_tls_t *tls, const void *data, size_t datalen);
int esp_tls_conn_destroy(esp_tls_t *tls);
esp_err_t esp_tls_get_conn_sockfd(esp_tls_t *tls, int *sockfd);
esp_err_t esp_tls_get_error_handle(esp_tls_t *tls,
    esp_tls_error_handle_t *error_handle);
esp_err_t esp_tls_get_and_clear_error_type(esp_tls_error_handle_t h,
    esp_tls_error_type_t err_type, int *error_code);
esp_err_t esp_tls_get_and_clear_last_error(esp_tls_error_handle_t h,
    int *esp_tls_code, int *esp_tls_flags);

#endif
