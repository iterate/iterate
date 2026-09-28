#ifndef ITERATE_KIT_TEST_FAKE_ESP_TLS_H
#define ITERATE_KIT_TEST_FAKE_ESP_TLS_H

#include "esp_tls.h"

#include <stdbool.h>
#include <stddef.h>
#include <sys/types.h>

/*
 * A scripted ESP-TLS. A connection that succeeds owns a real, unconnected TCP
 * socket, so the stream's fcntl and setsockopt act on a descriptor that can
 * refuse them; every read and write answers from its script in order.
 */

enum { FAKE_ESP_TLS_SCRIPT = 16 };

/** One scripted read or write: its result, the errno it leaves, what ESP-TLS recorded. */
struct fake_esp_tls_step {
  ssize_t result;
  int socket_errno;
  esp_err_t recorded_error;
  const char *bytes;
};

struct fake_esp_tls {
  /* Set by the test before connect. */
  int connect_result;
  esp_err_t connect_error;
  int connect_socket_errno;
  struct fake_esp_tls_step reads[FAKE_ESP_TLS_SCRIPT];
  size_t read_count;
  struct fake_esp_tls_step writes[FAKE_ESP_TLS_SCRIPT];
  size_t write_count;
  int sha1_result;
  /* Observed. */
  char host[256];
  int port;
  esp_tls_cfg_t configuration;
  tls_keep_alive_cfg_t keep_alive;
  bool keep_alive_set;
  int descriptor;
  size_t reads_done;
  size_t writes_done;
  size_t read_capacity;
  size_t write_size;
  unsigned int connections;
  unsigned int destroyed;
  unsigned int live;
};

extern struct fake_esp_tls fake_esp_tls;

void fake_esp_tls_reset(void);

#endif
