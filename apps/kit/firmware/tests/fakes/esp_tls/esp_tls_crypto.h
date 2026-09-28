#ifndef ITERATE_KIT_TEST_ESP_TLS_CRYPTO_H
#define ITERATE_KIT_TEST_ESP_TLS_CRYPTO_H
#include <stddef.h>
int esp_crypto_sha1(const unsigned char *input, size_t ilen, unsigned char output[20]);
#endif
