#include "fake_esp_tls.h"

#include "esp_crt_bundle.h"
#include "esp_tls_crypto.h"

#include <assert.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

struct fake_esp_tls fake_esp_tls;

struct esp_tls_last_error {
  esp_err_t last_error;
  int socket_errno;
};

struct esp_tls {
  struct esp_tls_last_error error;
  int descriptor;
};

void fake_esp_tls_reset(void) {
  memset(&fake_esp_tls, 0, sizeof(fake_esp_tls));
  fake_esp_tls.connect_result = 1;
  fake_esp_tls.descriptor = -1;
}

esp_err_t esp_crt_bundle_attach(void *conf) {
  (void)conf;
  return ESP_OK;
}

int esp_crypto_sha1(const unsigned char *input, size_t ilen, unsigned char output[20]) {
  (void)input;
  (void)ilen;
  memset(output, 0xA5, 20U);
  return fake_esp_tls.sha1_result;
}

esp_tls_t *esp_tls_init(void) {
  esp_tls_t *tls = calloc(1U, sizeof(*tls));
  assert(tls != NULL);
  tls->descriptor = -1;
  ++fake_esp_tls.live;
  return tls;
}

int esp_tls_conn_new_sync(const char *hostname, int hostlen, int port,
    const esp_tls_cfg_t *cfg, esp_tls_t *tls) {
  assert(hostlen > 0 && (size_t)hostlen < sizeof(fake_esp_tls.host));
  memcpy(fake_esp_tls.host, hostname, (size_t)hostlen);
  fake_esp_tls.host[hostlen] = '\0';
  fake_esp_tls.port = port;
  fake_esp_tls.configuration = *cfg;
  fake_esp_tls.keep_alive_set = cfg->keep_alive_cfg != NULL;
  if (cfg->keep_alive_cfg != NULL) fake_esp_tls.keep_alive = *cfg->keep_alive_cfg;
  ++fake_esp_tls.connections;
  if (fake_esp_tls.connect_result != 1) {
    tls->error.last_error = fake_esp_tls.connect_error;
    tls->error.socket_errno = fake_esp_tls.connect_socket_errno;
    return fake_esp_tls.connect_result;
  }
  tls->descriptor = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  assert(tls->descriptor >= 0);
  fake_esp_tls.descriptor = tls->descriptor;
  return 1;
}

static ssize_t play(
    esp_tls_t *tls, const struct fake_esp_tls_step *step, void *data, size_t size) {
  errno = step->socket_errno;
  tls->error.last_error = step->recorded_error;
  if (step->result > 0 && data != NULL) {
    assert((size_t)step->result <= size);
    memcpy(data, step->bytes, (size_t)step->result);
  }
  return step->result;
}

ssize_t esp_tls_conn_read(esp_tls_t *tls, void *data, size_t datalen) {
  assert(fake_esp_tls.reads_done < fake_esp_tls.read_count);
  fake_esp_tls.read_capacity = datalen;
  return play(tls, &fake_esp_tls.reads[fake_esp_tls.reads_done++], data, datalen);
}

ssize_t esp_tls_conn_write(esp_tls_t *tls, const void *data, size_t datalen) {
  (void)data;
  assert(fake_esp_tls.writes_done < fake_esp_tls.write_count);
  fake_esp_tls.write_size = datalen;
  return play(tls, &fake_esp_tls.writes[fake_esp_tls.writes_done++], NULL, datalen);
}

int esp_tls_conn_destroy(esp_tls_t *tls) {
  if (tls->descriptor >= 0) (void)close(tls->descriptor);
  free(tls);
  ++fake_esp_tls.destroyed;
  --fake_esp_tls.live;
  return 0;
}

esp_err_t esp_tls_get_conn_sockfd(esp_tls_t *tls, int *sockfd) {
  *sockfd = tls->descriptor;
  return ESP_OK;
}

esp_err_t esp_tls_get_error_handle(esp_tls_t *tls, esp_tls_error_handle_t *error_handle) {
  *error_handle = &tls->error;
  return ESP_OK;
}

esp_err_t esp_tls_get_and_clear_error_type(esp_tls_error_handle_t h,
    esp_tls_error_type_t err_type, int *error_code) {
  assert(err_type == ESP_TLS_ERR_TYPE_SYSTEM);
  *error_code = h->socket_errno;
  h->socket_errno = 0;
  return ESP_OK;
}

esp_err_t esp_tls_get_and_clear_last_error(esp_tls_error_handle_t h,
    int *esp_tls_code, int *esp_tls_flags) {
  const esp_err_t error = h->last_error;
  *esp_tls_code = 0;
  *esp_tls_flags = 0;
  h->last_error = ESP_OK;
  return error;
}
