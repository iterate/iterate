#ifndef ITERATE_KIT_TESTS_FAKE_ESP_PARTITION_H
#define ITERATE_KIT_TESTS_FAKE_ESP_PARTITION_H

#include <stddef.h>
#include <stdint.h>

typedef int32_t esp_err_t;

enum {
  ESP_OK = 0,
};

typedef enum {
  ESP_PARTITION_TYPE_APP = 0x00,
  ESP_PARTITION_TYPE_DATA = 0x01,
} esp_partition_type_t;

typedef enum {
  ESP_PARTITION_SUBTYPE_ANY = 0xff,
} esp_partition_subtype_t;

typedef enum {
  ESP_PARTITION_MMAP_DATA = 0,
  ESP_PARTITION_MMAP_INST,
} esp_partition_mmap_memory_t;

typedef uint32_t esp_partition_mmap_handle_t;

typedef struct {
  esp_partition_type_t type;
  esp_partition_subtype_t subtype;
  uint32_t address;
  uint32_t size;
  char label[17];
} esp_partition_t;

const esp_partition_t *esp_partition_find_first(
    esp_partition_type_t type,
    esp_partition_subtype_t subtype,
    const char *label);
esp_err_t esp_partition_mmap(
    const esp_partition_t *partition,
    size_t offset,
    size_t size,
    esp_partition_mmap_memory_t memory,
    const void **out_ptr,
    esp_partition_mmap_handle_t *out_handle);
void esp_partition_munmap(esp_partition_mmap_handle_t handle);

#endif
