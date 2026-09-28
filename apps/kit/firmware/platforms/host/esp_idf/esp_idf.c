#include "esp_idf.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_system.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* See esp_idf.h for what this is. Everything is file-static because everything it
 * stands in for is: a device has one clock, one heap and one watchdog. */

enum {
  /* Two on every board — capture and playback — plus room to notice a third. */
  FAKE_TASK_CAPACITY = 8,
  FAKE_QUEUE_CAPACITY = 8,
  FAKE_RESTART_NOTE_CAPACITY = 128,
};

struct iterate_kit_fake_queue {
  uint8_t *storage;
  size_t item_bytes;
  size_t depth;
  size_t head;
  size_t count;
  bool live;
};

static struct {
  bool clock_pinned;
  int64_t now_us;
  size_t tasks_created;
  struct iterate_kit_fake_queue queues[FAKE_QUEUE_CAPACITY];
  bool restart_requested;
  char restart_note[FAKE_RESTART_NOTE_CAPACITY];
  bool log_enabled;
  bool log_checked;
} fake;

void iterate_kit_host_esp_idf_reset(void) {
  size_t index;
  for (index = 0U; index < FAKE_QUEUE_CAPACITY; ++index) {
    free(fake.queues[index].storage);
  }
  memset(&fake, 0, sizeof(fake));
}

void iterate_kit_host_esp_idf_set_now_us(int64_t now_us) {
  fake.clock_pinned = true;
  fake.now_us = now_us;
}

void iterate_kit_host_esp_idf_set_restart_note(const char *note) {
  (void)snprintf(
      fake.restart_note, sizeof(fake.restart_note), "%s", note == NULL ? "" : note);
}

void iterate_kit_host_esp_idf_advance_ms(uint32_t milliseconds) {
  fake.now_us += (int64_t)milliseconds * 1000;
}

size_t iterate_kit_host_esp_idf_tasks_created(void) {
  return fake.tasks_created;
}

bool iterate_kit_host_esp_idf_restart_requested(void) {
  return fake.restart_requested;
}

/* --- clock ---------------------------------------------------------------- */

int64_t esp_timer_get_time(void) {
  struct timespec now;
  if (fake.clock_pinned) return fake.now_us;
  (void)clock_gettime(CLOCK_MONOTONIC, &now);
  return (int64_t)now.tv_sec * 1000000 + now.tv_nsec / 1000;
}

uint32_t esp_random(void) {
  static bool seeded;
  if (!seeded) {
    FILE *urandom = fopen("/dev/urandom", "rb");
    unsigned int seed = (unsigned int)time(NULL);
    if (urandom != NULL) {
      (void)fread(&seed, sizeof(seed), 1, urandom);
      (void)fclose(urandom);
    }
    srandom(seed);
    seeded = true;
  }
  return ((uint32_t)random() << 16) ^ (uint32_t)random();
}

/* --- logging -------------------------------------------------------------- */

void iterate_kit_host_esp_log(
    const char *level, const char *tag, const char *format, ...) {
  va_list arguments;
  if (!fake.log_checked) {
    /* A test is quiet unless asked; a device on a laptop talks by default. */
    const char *setting = getenv("ITERATE_KIT_ESP_LOG");
    fake.log_enabled = setting == NULL ? !fake.clock_pinned
                                       : (setting[0] != '\0' && setting[0] != '0');
    fake.log_checked = true;
  }
  if (!fake.log_enabled) return;
  (void)fprintf(stderr, "%s (%s) ", level, tag);
  va_start(arguments, format);
  (void)vfprintf(stderr, format, arguments);
  va_end(arguments);
  (void)fputc('\n', stderr);
}

/* --- heap and system ------------------------------------------------------ */

void *heap_caps_malloc(size_t size, uint32_t capabilities) {
  (void)capabilities;
  return malloc(size);
}

void heap_caps_free(void *pointer) { free(pointer); }

size_t heap_caps_get_free_size(uint32_t capabilities) {
  (void)capabilities;
  return 4U * 1024U * 1024U;
}

size_t heap_caps_get_largest_free_block(uint32_t capabilities) {
  (void)capabilities;
  return 1U * 1024U * 1024U;
}

uint32_t esp_get_free_heap_size(void) { return 4U * 1024U * 1024U; }
uint32_t esp_get_minimum_free_heap_size(void) { return 3U * 1024U * 1024U; }

size_t heap_caps_get_minimum_free_size(uint32_t capabilities) {
  (void)capabilities;
  return 3U * 1024U * 1024U;
}

/*
 * Under a pinned clock a restart is RECORDED, NOT HONOURED: obeying it would
 * end the test process instead of failing an assertion. A device on a laptop
 * has no other way to come back than to leave, so it says why and exits.
 */
void esp_restart(void) {
  fake.restart_requested = true;
  if (fake.clock_pinned) return;
  (void)fprintf(stderr, "restart: %s\n", fake.restart_note);
  exit(70);
}

esp_err_t esp_task_wdt_add(void *task) {
  (void)task;
  return ESP_OK;
}

esp_err_t esp_task_wdt_reset(void) { return ESP_OK; }

esp_err_t esp_netif_sntp_init(const esp_sntp_config_t *config) {
  (void)config;
  return ESP_OK;
}

/* --- tasks ---------------------------------------------------------------- */

BaseType_t xTaskCreatePinnedToCore(
    TaskFunction_t body,
    const char *name,
    uint32_t stack_bytes,
    void *argument,
    UBaseType_t priority,
    TaskHandle_t *created,
    BaseType_t core) {
  (void)body;
  (void)name;
  (void)stack_bytes;
  (void)argument;
  (void)priority;
  (void)core;
  if (fake.tasks_created >= FAKE_TASK_CAPACITY) return pdFAIL;
  ++fake.tasks_created;
  /*
   * A NON-NULL HANDLE THAT IS NOT A TASK. The loop only ever passes this back
   * to vTaskDelete on the failure path, and NULL there would mean "the current
   * task" on hardware — so the handle must be distinguishable from NULL even
   * though nothing runs behind it.
   */
  if (created != NULL) *created = (TaskHandle_t)&fake.tasks_created;
  return pdPASS;
}

void vTaskDelete(TaskHandle_t task) { (void)task; }

/* Under a pinned clock a delay is a clock move, not a sleep. */
void vTaskDelay(TickType_t ticks) {
  if (fake.clock_pinned) {
    iterate_kit_host_esp_idf_advance_ms((uint32_t)ticks);
    return;
  }
  const struct timespec pause = {
    .tv_sec = (time_t)(ticks / 1000U), .tv_nsec = (long)(ticks % 1000U) * 1000000L};
  (void)nanosleep(&pause, NULL);
}

void vTaskPrioritySet(TaskHandle_t task, UBaseType_t priority) {
  (void)task;
  (void)priority;
}

TaskHandle_t xTaskGetCurrentTaskHandle(void) { return NULL; }

/* --- queues --------------------------------------------------------------- */

QueueHandle_t xQueueCreate(UBaseType_t depth, UBaseType_t item_bytes) {
  size_t index;
  if (depth == 0U || item_bytes == 0U) return NULL;
  for (index = 0U; index < FAKE_QUEUE_CAPACITY; ++index) {
    struct iterate_kit_fake_queue *queue = &fake.queues[index];
    if (queue->live) continue;
    queue->storage = calloc((size_t)depth, (size_t)item_bytes);
    if (queue->storage == NULL) return NULL;
    queue->item_bytes = (size_t)item_bytes;
    queue->depth = (size_t)depth;
    queue->head = 0U;
    queue->count = 0U;
    queue->live = true;
    return queue;
  }
  return NULL;
}

QueueHandle_t xQueueCreateWithCaps(
    UBaseType_t depth, UBaseType_t item_bytes, uint32_t capabilities) {
  (void)capabilities;
  return xQueueCreate(depth, item_bytes);
}

void vQueueDelete(QueueHandle_t queue) {
  if (queue == NULL || !queue->live) return;
  free(queue->storage);
  queue->storage = NULL;
  queue->live = false;
}

void vQueueDeleteWithCaps(QueueHandle_t queue) { vQueueDelete(queue); }

static uint8_t *slot(struct iterate_kit_fake_queue *queue, size_t offset) {
  return queue->storage +
      (((queue->head + offset) % queue->depth) * queue->item_bytes);
}

BaseType_t xQueueSend(QueueHandle_t queue, const void *item, TickType_t wait) {
  (void)wait;
  if (queue == NULL || !queue->live || item == NULL) return pdFAIL;
  if (queue->count == queue->depth) return pdFAIL;
  memcpy(slot(queue, queue->count), item, queue->item_bytes);
  ++queue->count;
  return pdTRUE;
}

BaseType_t xQueueSendToFront(
    QueueHandle_t queue, const void *item, TickType_t wait) {
  (void)wait;
  if (queue == NULL || !queue->live || item == NULL) return pdFAIL;
  if (queue->count == queue->depth) return pdFAIL;
  queue->head = (queue->head + queue->depth - 1U) % queue->depth;
  memcpy(slot(queue, 0U), item, queue->item_bytes);
  ++queue->count;
  return pdTRUE;
}

BaseType_t xQueueReceive(QueueHandle_t queue, void *item, TickType_t wait) {
  /*
   * NO WAITING. On hardware a starved consumer blocks here and another task
   * fills the queue; on one thread that would deadlock, so an empty queue
   * answers immediately and the caller sees the same "nothing arrived in time"
   * it sees on a device whose producer is late.
   *
   * THE TIMEOUT IS SPENT ONLY WHEN IT IS ACTUALLY WAITED OUT. Charging it on
   * every receive made the modelled speaker consume 40 ms of clock per 20 ms
   * frame — half realtime — so playback accumulated lag it could never have on
   * a board, and the catch-up rule then deleted frames to pay for the fake's
   * own arithmetic. A receive that finds a frame returns at once on hardware,
   * and does here.
   */
  if (queue == NULL || !queue->live || item == NULL) {
    if (wait != 0U) iterate_kit_host_esp_idf_advance_ms((uint32_t)wait);
    return pdFAIL;
  }
  if (queue->count == 0U) {
    if (wait != 0U) iterate_kit_host_esp_idf_advance_ms((uint32_t)wait);
    return pdFAIL;
  }
  memcpy(item, slot(queue, 0U), queue->item_bytes);
  queue->head = (queue->head + 1U) % queue->depth;
  --queue->count;
  return pdTRUE;
}

BaseType_t xQueueReset(QueueHandle_t queue) {
  if (queue == NULL || !queue->live) return pdFAIL;
  queue->head = 0U;
  queue->count = 0U;
  return pdTRUE;
}

UBaseType_t uxQueueMessagesWaiting(QueueHandle_t queue) {
  if (queue == NULL || !queue->live) return 0U;
  return (UBaseType_t)queue->count;
}

UBaseType_t uxQueueSpacesAvailable(QueueHandle_t queue) {
  if (queue == NULL || !queue->live) return 0U;
  return (UBaseType_t)(queue->depth - queue->count);
}
