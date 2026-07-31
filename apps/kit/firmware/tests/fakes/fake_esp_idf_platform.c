#include "fake_esp_idf_platform.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"

#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <string.h>
#include <time.h>

const char iterate_kit_fake_wifi_event_base[] = "WIFI_EVENT";
const char iterate_kit_fake_ip_event_base[] = "IP_EVENT";

struct iterate_kit_fake_task {
  pthread_t thread;
  pthread_mutex_t mutex;
  pthread_cond_t condition;
  TaskFunction_t function;
  void *context;
  uint32_t notifications;
  uint32_t returned;
  unsigned int priority;
  int core_id;
  bool pause_requested;
  bool paused;
  bool created;
};

struct iterate_kit_fake_websocket_client {
  esp_websocket_client_config_t configuration;
  esp_event_handler_t event_handler;
  void *event_context;
  uint32_t started;
  uint32_t connected_emitted;
};

static esp_event_handler_t wifi_handler;
static void *wifi_handler_context;
static esp_event_handler_t ip_handler;
static void *ip_handler_context;
static esp_netif_t station = {0x49545855U};
static struct iterate_kit_fake_task network_task;
static struct iterate_kit_fake_websocket_client websocket_client;
static uint32_t defer_connected;
static uint32_t short_next_send;
static int64_t monotonic_clock_offset_us;

static void add_milliseconds(
    struct timespec *deadline, TickType_t milliseconds) {
  const long nanoseconds_per_second = 1000000000L;
  const long added_nanoseconds =
      (long)(milliseconds % 1000U) * 1000000L;
  deadline->tv_sec += (time_t)(milliseconds / 1000U);
  deadline->tv_nsec += added_nanoseconds;
  if (deadline->tv_nsec >= nanoseconds_per_second) {
    deadline->tv_nsec -= nanoseconds_per_second;
    ++deadline->tv_sec;
  }
}

static void *run_task(void *context) {
  struct iterate_kit_fake_task *task = context;
  task->function(task->context);
  /*
   * FreeRTOS deletes the static task at vTaskDelete(NULL); pthreads need an
   * explicit fixture join as well. Publish host return separately so the test
   * can prove production stop reached its cooperative exit before releasing
   * the fake scheduler storage.
   */
  __atomic_store_n(&task->returned, 1U, __ATOMIC_RELEASE);
  return NULL;
}

esp_err_t esp_event_loop_create_default(void) {
  return ESP_OK;
}

esp_err_t esp_event_loop_delete_default(void) {
  return ESP_OK;
}

esp_err_t esp_event_handler_instance_register(
    esp_event_base_t base,
    int32_t event_id,
    esp_event_handler_t handler,
    void *context,
    esp_event_handler_instance_t *instance) {
  (void)event_id;
  if (base == NULL || handler == NULL || instance == NULL) {
    return ESP_FAIL;
  }
  if (strcmp(base, WIFI_EVENT) == 0) {
    wifi_handler = handler;
    wifi_handler_context = context;
  } else if (strcmp(base, IP_EVENT) == 0) {
    ip_handler = handler;
    ip_handler_context = context;
  } else {
    return ESP_FAIL;
  }
  *instance = (esp_event_handler_instance_t)handler;
  return ESP_OK;
}

esp_err_t esp_event_handler_instance_unregister(
    esp_event_base_t base,
    int32_t event_id,
    esp_event_handler_instance_t instance) {
  (void)event_id;
  (void)instance;
  if (base != NULL && strcmp(base, WIFI_EVENT) == 0) {
    wifi_handler = NULL;
    wifi_handler_context = NULL;
  } else if (base != NULL && strcmp(base, IP_EVENT) == 0) {
    ip_handler = NULL;
    ip_handler_context = NULL;
  }
  return ESP_OK;
}

esp_err_t esp_netif_init(void) {
  return ESP_OK;
}

esp_netif_t *esp_netif_create_default_wifi_sta(void) {
  return &station;
}

void esp_netif_destroy_default_wifi(esp_netif_t *netif) {
  (void)netif;
}

esp_err_t esp_wifi_init(const wifi_init_config_t *configuration) {
  return configuration == NULL ? ESP_FAIL : ESP_OK;
}

esp_err_t esp_wifi_set_storage(int storage) {
  (void)storage;
  return ESP_OK;
}

esp_err_t esp_wifi_set_mode(int mode) {
  (void)mode;
  return ESP_OK;
}

esp_err_t esp_wifi_set_config(
    int interface_id, const wifi_config_t *configuration) {
  (void)interface_id;
  return configuration == NULL ? ESP_FAIL : ESP_OK;
}

esp_err_t esp_wifi_set_ps(int power_save) {
  (void)power_save;
  return ESP_OK;
}

esp_err_t esp_wifi_start(void) {
  if (wifi_handler != NULL) {
    wifi_handler(
        wifi_handler_context,
        WIFI_EVENT,
        WIFI_EVENT_STA_START,
        NULL);
  }
  return ESP_OK;
}

esp_err_t esp_wifi_connect(void) {
  if (ip_handler != NULL) {
    ip_handler(
        ip_handler_context,
        IP_EVENT,
        IP_EVENT_STA_GOT_IP,
        NULL);
  }
  return ESP_OK;
}

esp_err_t esp_wifi_stop(void) {
  return ESP_OK;
}

esp_err_t esp_wifi_deinit(void) {
  return ESP_OK;
}

esp_err_t nvs_flash_init(void) {
  return ESP_OK;
}

esp_err_t nvs_flash_erase(void) {
  return ESP_OK;
}

esp_websocket_client_handle_t esp_websocket_client_init(
    const esp_websocket_client_config_t *configuration) {
  if (configuration == NULL) {
    return NULL;
  }
  memset(&websocket_client, 0, sizeof(websocket_client));
  websocket_client.configuration = *configuration;
  return &websocket_client;
}

esp_err_t esp_websocket_register_events(
    esp_websocket_client_handle_t client,
    int32_t event_id,
    esp_event_handler_t handler,
    void *context) {
  (void)event_id;
  if (client == NULL || handler == NULL) {
    return ESP_FAIL;
  }
  client->event_handler = handler;
  client->event_context = context;
  return ESP_OK;
}

esp_err_t esp_websocket_client_start(
    esp_websocket_client_handle_t client) {
  if (client == NULL || client->event_handler == NULL) {
    return ESP_FAIL;
  }
  /*
   * The production network task owns start/stop while the test thread injects
   * callbacks. Making this lifecycle flag atomic preserves that actual
   * cross-task relationship; a plain host bool would give ThreadSanitizer a
   * fake-only race and could make the regression pass or fail by optimization.
   */
  __atomic_store_n(&client->started, 1U, __ATOMIC_RELEASE);
  __atomic_store_n(
      &client->connected_emitted, 0U, __ATOMIC_RELEASE);
  if (__atomic_load_n(
          &defer_connected, __ATOMIC_ACQUIRE) == 0U) {
    return iterate_kit_fake_websocket_emit_connected(
        client);
  }
  return ESP_OK;
}

esp_err_t esp_websocket_client_stop(
    esp_websocket_client_handle_t client) {
  if (client == NULL) {
    return ESP_FAIL;
  }
  __atomic_store_n(&client->started, 0U, __ATOMIC_RELEASE);
  return ESP_OK;
}

int esp_websocket_client_send_text(
    esp_websocket_client_handle_t client,
    const char *data,
    int length,
    uint32_t timeout_ticks) {
  (void)timeout_ticks;
  if (client == NULL ||
      __atomic_load_n(&client->started, __ATOMIC_ACQUIRE) == 0U ||
      data == NULL ||
      length < 0) {
    return -1;
  }
  if (__atomic_exchange_n(
          &short_next_send, 0U, __ATOMIC_ACQ_REL) != 0U) {
    /*
     * ESP-IDF exposes one integer result, not a resumable byte cursor. A
     * one-byte-short outcome is therefore the strongest ambiguity: production
     * must abandon the generation rather than assume either zero or full
     * delivery. Consume the script once so the replacement can recover.
     */
    return length > 0 ? length - 1 : -1;
  }
  return length;
}

esp_err_t esp_websocket_client_destroy(
    esp_websocket_client_handle_t client) {
  const struct iterate_kit_esp_idf_itx_transport *transport;
  if (client == NULL) {
    return ESP_FAIL;
  }
  transport = client->configuration.user_context;
  if (network_task.created &&
      (transport == NULL ||
       __atomic_load_n(
           &transport->network_task_exited,
           __ATOMIC_ACQUIRE) == 0U)) {
    /*
     * A fake that joined here used to make an invalid production teardown look
     * correct—or deadlock if destruction moved onto the network task. The
     * production transport publishes `network_task_exited` only after its last
     * client/ring access, so reject every earlier destroy and leave the host
     * pthread join to fixture teardown.
     */
    return ESP_ERR_INVALID_STATE;
  }
  memset(client, 0, sizeof(*client));
  return ESP_OK;
}

esp_err_t esp_crt_bundle_attach(void *configuration) {
  (void)configuration;
  return ESP_OK;
}

uint32_t esp_cpu_get_cycle_count(void) {
  static uint32_t cycle_count;
  cycle_count += 1000U;
  return cycle_count;
}

int64_t esp_timer_get_time(void) {
  struct timespec now;
  (void)clock_gettime(CLOCK_MONOTONIC, &now);
  return (int64_t)now.tv_sec * 1000000 +
      (int64_t)now.tv_nsec / 1000 +
      __atomic_load_n(
          &monotonic_clock_offset_us, __ATOMIC_ACQUIRE);
}

void iterate_kit_fake_monotonic_clock_reset(void) {
  __atomic_store_n(
      &monotonic_clock_offset_us, 0, __ATOMIC_RELEASE);
}

void iterate_kit_fake_monotonic_clock_advance_ms(
    uint32_t milliseconds) {
  /*
   * uint32 milliseconds fits safely when widened before multiplying. Use an
   * atomic add because the test thread moves time while the production
   * network task samples it; a plain fake global would introduce a host-only
   * data race that says nothing about ESP behavior.
   */
  (void)__atomic_fetch_add(
      &monotonic_clock_offset_us,
      (int64_t)milliseconds * 1000,
      __ATOMIC_ACQ_REL);
}

TaskHandle_t xTaskCreateStaticPinnedToCore(
    TaskFunction_t function,
    const char *name,
    uint32_t stack_depth,
    void *context,
    unsigned int priority,
    StackType_t *stack,
    StaticTask_t *task_storage,
    int core_id) {
  (void)name;
  (void)stack_depth;
  (void)priority;
  (void)stack;
  (void)task_storage;
  if (function == NULL || network_task.created) {
    return NULL;
  }
  memset(&network_task, 0, sizeof(network_task));
  if (pthread_mutex_init(&network_task.mutex, NULL) != 0 ||
      pthread_cond_init(&network_task.condition, NULL) != 0) {
    return NULL;
  }
  network_task.function = function;
  network_task.context = context;
  network_task.priority = priority;
  network_task.core_id = core_id;
  network_task.created = true;
  if (pthread_create(
          &network_task.thread,
          NULL,
          run_task,
          &network_task) != 0) {
    network_task.created = false;
    (void)pthread_cond_destroy(&network_task.condition);
    (void)pthread_mutex_destroy(&network_task.mutex);
    return NULL;
  }
  return &network_task;
}

int iterate_kit_fake_network_task_core_id(void) {
  return network_task.created ? network_task.core_id : -1;
}

unsigned int iterate_kit_fake_network_task_priority(void) {
  return network_task.created ? network_task.priority : 0U;
}

void xTaskNotifyGive(TaskHandle_t task) {
  if (task == NULL || !task->created) {
    return;
  }
  (void)pthread_mutex_lock(&task->mutex);
  if (task->notifications != UINT32_MAX) {
    ++task->notifications;
  }
  (void)pthread_cond_signal(&task->condition);
  (void)pthread_mutex_unlock(&task->mutex);
}

uint32_t ulTaskNotifyTake(
    int clear_count_on_exit, TickType_t timeout_ticks) {
  uint32_t notifications;
  struct timespec deadline;
  (void)pthread_mutex_lock(&network_task.mutex);
  if (timeout_ticks > 0U) {
    (void)clock_gettime(CLOCK_REALTIME, &deadline);
    add_milliseconds(&deadline, timeout_ticks);
  }
  for (;;) {
    while (network_task.pause_requested) {
      /*
       * Pause only at the production task's notification boundary. Stopping a
       * pthread at an arbitrary instruction would manufacture races that
       * FreeRTOS never exposes and could freeze it while owning a ring slot.
       */
      network_task.paused = true;
      (void)pthread_cond_broadcast(
          &network_task.condition);
      (void)pthread_cond_wait(
          &network_task.condition,
          &network_task.mutex);
    }
    if (network_task.paused) {
      network_task.paused = false;
      (void)pthread_cond_broadcast(
          &network_task.condition);
    }
    if (network_task.notifications > 0U ||
        timeout_ticks == 0U) {
      break;
    }
    {
      const int result = pthread_cond_timedwait(
          &network_task.condition,
          &network_task.mutex,
          &deadline);
      if (result == ETIMEDOUT) {
        break;
      }
    }
  }
  notifications = network_task.notifications;
  if (notifications > 0U) {
    if (clear_count_on_exit) {
      network_task.notifications = 0U;
    } else {
      --network_task.notifications;
    }
  }
  (void)pthread_mutex_unlock(&network_task.mutex);
  return notifications;
}

uint32_t uxTaskGetStackHighWaterMark(TaskHandle_t task) {
  (void)task;
  /*
   * The transport only needs a value safely above its fail-closed threshold.
   * Precise host stack use would say nothing about the ESP32 ABI and belongs in
   * the target size/runtime evidence lane, not this state-machine test.
   */
  return 2048U;
}

void vTaskDelay(TickType_t ticks) {
  struct timespec delay = {
    .tv_sec = (time_t)(ticks / 1000U),
    .tv_nsec = (long)(ticks % 1000U) * 1000000L,
  };
  (void)nanosleep(&delay, NULL);
}

void vTaskDelete(TaskHandle_t task) {
  (void)task;
}

esp_err_t iterate_kit_fake_websocket_emit_frame(
    esp_websocket_client_handle_t client,
    int opcode,
    const char *data,
    size_t data_length,
    size_t payload_length,
    size_t payload_offset,
    bool fin) {
  esp_websocket_event_data_t event;
  if (client == NULL ||
      __atomic_load_n(&client->started, __ATOMIC_ACQUIRE) == 0U ||
      client->event_handler == NULL ||
      data_length > (size_t)INT_MAX ||
      payload_length > (size_t)INT_MAX ||
      payload_offset > (size_t)INT_MAX) {
    return ESP_FAIL;
  }
  event = (esp_websocket_event_data_t){
    .data_ptr = data,
    .data_len = (int)data_length,
    .payload_len = (int)payload_length,
    .payload_offset = (int)payload_offset,
    .op_code = opcode,
    .fin = fin,
    .error_handle = {.esp_tls_last_esp_err = ESP_OK},
  };
  client->event_handler(
      client->event_context,
      "WEBSOCKET_EVENT",
      WEBSOCKET_EVENT_DATA,
      &event);
  return ESP_OK;
}

esp_err_t iterate_kit_fake_websocket_emit_text(
    esp_websocket_client_handle_t client,
    const char *data,
    size_t data_length,
    size_t payload_length,
    size_t payload_offset,
    bool fin) {
  return iterate_kit_fake_websocket_emit_frame(
      client,
      1,
      data,
      data_length,
      payload_length,
      payload_offset,
      fin);
}

void iterate_kit_fake_websocket_defer_connected(
    bool enabled) {
  __atomic_store_n(
      &defer_connected,
      enabled ? 1U : 0U,
      __ATOMIC_RELEASE);
}

esp_err_t iterate_kit_fake_websocket_emit_connected(
    esp_websocket_client_handle_t client) {
  esp_websocket_event_data_t event = {0};
  uint32_t expected = 0U;
  if (client == NULL ||
      __atomic_load_n(
          &client->started, __ATOMIC_ACQUIRE) == 0U ||
      client->event_handler == NULL ||
      !__atomic_compare_exchange_n(
          &client->connected_emitted,
          &expected,
          1U,
          false,
          __ATOMIC_ACQ_REL,
          __ATOMIC_ACQUIRE)) {
    return ESP_ERR_INVALID_STATE;
  }
  /*
   * Tests normally call this from their application thread, standing in for
   * ESP-IDF's independent WebSocket dispatcher. The compare/exchange prevents
   * an accidental duplicate CONNECTED event from creating fake generations.
   */
  client->event_handler(
      client->event_context,
      "WEBSOCKET_EVENT",
      WEBSOCKET_EVENT_CONNECTED,
      &event);
  return ESP_OK;
}

esp_err_t iterate_kit_fake_websocket_emit_error(
    esp_websocket_client_handle_t client,
    esp_websocket_error_type_t error_type,
    esp_err_t tls_error,
    int tls_stack_error,
    int transport_errno,
    int handshake_status_code,
    int close_status_code) {
  esp_websocket_event_data_t event = {
    .error_handle = {
      .esp_tls_last_esp_err = tls_error,
      .esp_tls_stack_err = tls_stack_error,
      .error_type = error_type,
      .esp_ws_handshake_status_code = handshake_status_code,
      .esp_transport_sock_errno = transport_errno,
    },
    .close_status_code = close_status_code,
  };
  if (client == NULL ||
      __atomic_load_n(&client->started, __ATOMIC_ACQUIRE) == 0U ||
      client->event_handler == NULL) {
    return ESP_FAIL;
  }
  client->event_handler(
      client->event_context,
      "WEBSOCKET_EVENT",
      WEBSOCKET_EVENT_ERROR,
      &event);
  return ESP_OK;
}

void iterate_kit_fake_websocket_short_next_send(void) {
  __atomic_store_n(
      &short_next_send, 1U, __ATOMIC_RELEASE);
}

esp_err_t iterate_kit_fake_network_task_pause(void) {
  struct timespec deadline;
  if (!network_task.created) {
    return ESP_ERR_INVALID_STATE;
  }
  (void)clock_gettime(CLOCK_REALTIME, &deadline);
  add_milliseconds(&deadline, 2000U);
  (void)pthread_mutex_lock(&network_task.mutex);
  if (network_task.pause_requested) {
    (void)pthread_mutex_unlock(&network_task.mutex);
    return ESP_ERR_INVALID_STATE;
  }
  network_task.pause_requested = true;
  (void)pthread_cond_broadcast(&network_task.condition);
  while (!network_task.paused) {
    const int result = pthread_cond_timedwait(
        &network_task.condition,
        &network_task.mutex,
        &deadline);
    if (result == ETIMEDOUT) {
      network_task.pause_requested = false;
      (void)pthread_cond_broadcast(
          &network_task.condition);
      (void)pthread_mutex_unlock(&network_task.mutex);
      return ESP_FAIL;
    }
  }
  (void)pthread_mutex_unlock(&network_task.mutex);
  return ESP_OK;
}

esp_err_t iterate_kit_fake_network_task_resume(void) {
  struct timespec deadline;
  if (!network_task.created) {
    return ESP_ERR_INVALID_STATE;
  }
  (void)clock_gettime(CLOCK_REALTIME, &deadline);
  add_milliseconds(&deadline, 2000U);
  (void)pthread_mutex_lock(&network_task.mutex);
  if (!network_task.pause_requested) {
    (void)pthread_mutex_unlock(&network_task.mutex);
    return ESP_ERR_INVALID_STATE;
  }
  network_task.pause_requested = false;
  (void)pthread_cond_broadcast(&network_task.condition);
  while (network_task.paused) {
    const int result = pthread_cond_timedwait(
        &network_task.condition,
        &network_task.mutex,
        &deadline);
    if (result == ETIMEDOUT) {
      (void)pthread_mutex_unlock(&network_task.mutex);
      return ESP_FAIL;
    }
  }
  (void)pthread_mutex_unlock(&network_task.mutex);
  return ESP_OK;
}

esp_err_t iterate_kit_fake_platform_finish(void) {
  int join_result;
  if (!network_task.created) {
    return ESP_ERR_INVALID_STATE;
  }
  if (network_task.pause_requested ||
      network_task.paused) {
    return ESP_ERR_INVALID_STATE;
  }
  join_result = pthread_join(network_task.thread, NULL);
  if (join_result != 0 ||
      __atomic_load_n(
          &network_task.returned, __ATOMIC_ACQUIRE) == 0U) {
    return ESP_FAIL;
  }
  if (pthread_cond_destroy(&network_task.condition) != 0 ||
      pthread_mutex_destroy(&network_task.mutex) != 0) {
    return ESP_FAIL;
  }
  /*
   * Tests execute multiple complete transport lifecycles in one process. Only
   * fixture teardown resets the singleton fake, after the thread is joined;
   * resetting it in client destroy would permit another task to reuse storage
   * while the prior pthread was still unwinding.
   */
  memset(&network_task, 0, sizeof(network_task));
  memset(&websocket_client, 0, sizeof(websocket_client));
  __atomic_store_n(
      &defer_connected, 0U, __ATOMIC_RELEASE);
  __atomic_store_n(
      &short_next_send, 0U, __ATOMIC_RELEASE);
  wifi_handler = NULL;
  wifi_handler_context = NULL;
  ip_handler = NULL;
  ip_handler_context = NULL;
  return ESP_OK;
}
