#include "fake_esp_idf.h"

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

/*
 * The pretend ESP-IDF. See README.md in this directory for what it is for.
 *
 * Everything is file-static because everything it stands in for is: a device
 * has one clock, one heap and one watchdog, and pretending otherwise here would
 * let a test pass on a program shape no board has.
 */

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
  int64_t now_us;
  const char *task_names[FAKE_TASK_CAPACITY];
  size_t tasks_created;
  struct iterate_kit_fake_queue queues[FAKE_QUEUE_CAPACITY];
  bool fail_next_queue;
  bool restart_requested;
  char restart_note[FAKE_RESTART_NOTE_CAPACITY];
  bool log_enabled;
  bool log_checked;
} fake;

void iterate_kit_fake_esp_idf_reset(void) {
  size_t index;
  for (index = 0U; index < FAKE_QUEUE_CAPACITY; ++index) {
    free(fake.queues[index].storage);
  }
  memset(&fake, 0, sizeof(fake));
}

void iterate_kit_fake_esp_idf_set_now_us(int64_t now_us) {
  fake.now_us = now_us;
}

void iterate_kit_fake_esp_idf_advance_ms(uint32_t milliseconds) {
  fake.now_us += (int64_t)milliseconds * 1000;
}

size_t iterate_kit_fake_esp_idf_tasks_created(void) {
  return fake.tasks_created;
}

const char *iterate_kit_fake_esp_idf_task_name(size_t index) {
  if (index >= fake.tasks_created) return "";
  return fake.task_names[index] == NULL ? "" : fake.task_names[index];
}

bool iterate_kit_fake_esp_idf_restart_requested(void) {
  return fake.restart_requested;
}

const char *iterate_kit_fake_esp_idf_restart_note(void) {
  return fake.restart_note;
}

void iterate_kit_fake_esp_idf_fail_next_queue(void) {
  fake.fail_next_queue = true;
}

/* --- clock ---------------------------------------------------------------- */

int64_t esp_timer_get_time(void) { return fake.now_us; }

/* --- logging -------------------------------------------------------------- */

void iterate_kit_fake_esp_log(
    const char *level, const char *tag, const char *format, ...) {
  va_list arguments;
  if (!fake.log_checked) {
    const char *setting = getenv("ITERATE_KIT_FAKE_ESP_LOG");
    fake.log_enabled = setting != NULL && setting[0] != '\0' &&
        setting[0] != '0';
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
 * RECORDED, NOT HONOURED. A real esp_restart() does not come back; obeying that
 * here would end the test process instead of failing an assertion, so the fact
 * is kept and control returns. A test that expects a healthy boot must assert
 * on iterate_kit_fake_esp_idf_restart_requested().
 */
void esp_restart(void) { fake.restart_requested = true; }

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
  (void)stack_bytes;
  (void)argument;
  (void)priority;
  (void)core;
  if (fake.tasks_created >= FAKE_TASK_CAPACITY) return pdFAIL;
  fake.task_names[fake.tasks_created] = name;
  ++fake.tasks_created;
  /*
   * A NON-NULL HANDLE THAT IS NOT A TASK. The loop only ever passes this back
   * to vTaskDelete on the failure path, and NULL there would mean "the current
   * task" on hardware — so the handle must be distinguishable from NULL even
   * though nothing runs behind it.
   */
  if (created != NULL) *created = (TaskHandle_t)&fake.task_names[0];
  return pdPASS;
}

void vTaskDelete(TaskHandle_t task) { (void)task; }

/*
 * A DELAY IS A CLOCK MOVE, NOT A SLEEP. The loop delays inside its retry waits;
 * sleeping for real would make a test of those take as long as the device does.
 */
void vTaskDelay(TickType_t ticks) {
  iterate_kit_fake_esp_idf_advance_ms((uint32_t)ticks);
}

void vTaskPrioritySet(TaskHandle_t task, UBaseType_t priority) {
  (void)task;
  (void)priority;
}

TaskHandle_t xTaskGetCurrentTaskHandle(void) { return NULL; }

/* --- queues --------------------------------------------------------------- */

QueueHandle_t xQueueCreate(UBaseType_t depth, UBaseType_t item_bytes) {
  size_t index;
  if (fake.fail_next_queue) {
    fake.fail_next_queue = false;
    return NULL;
  }
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
    if (wait != 0U) iterate_kit_fake_esp_idf_advance_ms((uint32_t)wait);
    return pdFAIL;
  }
  if (queue->count == 0U) {
    if (wait != 0U) iterate_kit_fake_esp_idf_advance_ms((uint32_t)wait);
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
