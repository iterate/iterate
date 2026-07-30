#ifndef ITERATE_KIT_TESTS_FAKE_ESP_IDF_PLATFORM_H
#define ITERATE_KIT_TESTS_FAKE_ESP_IDF_PLATFORM_H

/*
 * Minimal host ABI for exercising the real ESP-IDF control transport.
 *
 * This is deliberately a behavioral fake, not a second transport model. The
 * production source still owns reconnect policy, callback validation, SPSC
 * ownership, and Cap'n Web generation changes. The fake supplies only the
 * scheduler and platform events that a deterministic host test cannot obtain
 * from macOS. Keeping the surface here limited to symbols used by
 * itx_transport.c makes API drift a compile failure instead of silently
 * teaching the test a different design.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef int esp_err_t;

enum {
  ESP_OK = 0,
  ESP_FAIL = -1,
  ESP_ERR_NO_MEM = 0x101,
  ESP_ERR_INVALID_STATE = 0x103,
  ESP_ERR_INVALID_RESPONSE = 0x108,
  ESP_ERR_NVS_NO_FREE_PAGES = 0x110d,
  ESP_ERR_NVS_NEW_VERSION_FOUND = 0x1110,
};

typedef const char *esp_event_base_t;
typedef void *esp_event_handler_instance_t;
typedef void (*esp_event_handler_t)(
    void *context,
    esp_event_base_t base,
    int32_t event_id,
    void *event_data);

extern const char iterate_kit_fake_wifi_event_base[];
extern const char iterate_kit_fake_ip_event_base[];

#define WIFI_EVENT \
  ((esp_event_base_t)iterate_kit_fake_wifi_event_base)
#define IP_EVENT \
  ((esp_event_base_t)iterate_kit_fake_ip_event_base)

enum {
  ESP_EVENT_ANY_ID = -1,
  WIFI_EVENT_STA_START = 1,
  WIFI_EVENT_STA_DISCONNECTED = 2,
  IP_EVENT_STA_GOT_IP = 3,
};

esp_err_t esp_event_loop_create_default(void);
esp_err_t esp_event_loop_delete_default(void);
esp_err_t esp_event_handler_instance_register(
    esp_event_base_t base,
    int32_t event_id,
    esp_event_handler_t handler,
    void *context,
    esp_event_handler_instance_t *instance);
esp_err_t esp_event_handler_instance_unregister(
    esp_event_base_t base,
    int32_t event_id,
    esp_event_handler_instance_t instance);

typedef struct esp_netif {
  uint32_t marker;
} esp_netif_t;

esp_err_t esp_netif_init(void);
esp_netif_t *esp_netif_create_default_wifi_sta(void);
void esp_netif_destroy_default_wifi(esp_netif_t *netif);

typedef struct wifi_init_config {
  uint32_t marker;
} wifi_init_config_t;

#define WIFI_INIT_CONFIG_DEFAULT() ((wifi_init_config_t){0U})

typedef struct wifi_event_sta_disconnected {
  uint8_t reason;
} wifi_event_sta_disconnected_t;

typedef struct wifi_config {
  struct {
    uint8_t ssid[32];
    uint8_t password[64];
    int scan_method;
    int sort_method;
    struct {
      int authmode;
    } threshold;
    struct {
      bool capable;
      bool required;
    } pmf_cfg;
    int sae_pwe_h2e;
  } sta;
} wifi_config_t;

enum {
  WIFI_STORAGE_RAM = 0,
  WIFI_MODE_STA = 1,
  WIFI_IF_STA = 0,
  WIFI_PS_NONE = 0,
  WIFI_ALL_CHANNEL_SCAN = 0,
  WIFI_CONNECT_AP_BY_SIGNAL = 0,
  WIFI_AUTH_OPEN = 0,
  WIFI_AUTH_WPA2_PSK = 3,
  WPA3_SAE_PWE_BOTH = 3,
};

esp_err_t esp_wifi_init(const wifi_init_config_t *configuration);
esp_err_t esp_wifi_set_storage(int storage);
esp_err_t esp_wifi_set_mode(int mode);
esp_err_t esp_wifi_set_config(
    int interface_id, const wifi_config_t *configuration);
esp_err_t esp_wifi_set_ps(int power_save);
esp_err_t esp_wifi_start(void);
esp_err_t esp_wifi_connect(void);
esp_err_t esp_wifi_stop(void);
esp_err_t esp_wifi_deinit(void);

esp_err_t nvs_flash_init(void);
esp_err_t nvs_flash_erase(void);

struct iterate_kit_fake_websocket_client;
typedef struct iterate_kit_fake_websocket_client *
    esp_websocket_client_handle_t;

typedef struct esp_websocket_client_config {
  const char *uri;
  void *user_context;
  bool task_core_id_set;
  int task_prio;
  const char *task_name;
  int task_stack;
  int buffer_size;
  bool disable_auto_reconnect;
  bool enable_close_reconnect;
  int reconnect_timeout_ms;
  int network_timeout_ms;
  unsigned int ping_interval_sec;
  int pingpong_timeout_sec;
  bool keep_alive_enable;
  int keep_alive_idle;
  int keep_alive_interval;
  int keep_alive_count;
  esp_err_t (*crt_bundle_attach)(void *configuration);
} esp_websocket_client_config_t;

typedef struct esp_websocket_event_data {
  const char *data_ptr;
  int data_len;
  int payload_len;
  int payload_offset;
  int op_code;
  bool fin;
  struct {
    esp_err_t esp_tls_last_esp_err;
  } error_handle;
} esp_websocket_event_data_t;

enum {
  WEBSOCKET_EVENT_ANY = -1,
  WEBSOCKET_EVENT_CONNECTED = 1,
  WEBSOCKET_EVENT_DISCONNECTED = 2,
  WEBSOCKET_EVENT_DATA = 3,
  WEBSOCKET_EVENT_ERROR = 4,
  WEBSOCKET_EVENT_CLOSED = 5,
  WEBSOCKET_EVENT_FINISH = 6,
};

esp_websocket_client_handle_t esp_websocket_client_init(
    const esp_websocket_client_config_t *configuration);
esp_err_t esp_websocket_register_events(
    esp_websocket_client_handle_t client,
    int32_t event_id,
    esp_event_handler_t handler,
    void *context);
esp_err_t esp_websocket_client_start(
    esp_websocket_client_handle_t client);
esp_err_t esp_websocket_client_stop(
    esp_websocket_client_handle_t client);
int esp_websocket_client_send_text(
    esp_websocket_client_handle_t client,
    const char *data,
    int length,
    uint32_t timeout_ticks);
esp_err_t esp_websocket_client_destroy(
    esp_websocket_client_handle_t client);

esp_err_t esp_crt_bundle_attach(void *configuration);
uint32_t esp_cpu_get_cycle_count(void);
int64_t esp_timer_get_time(void);

typedef uint32_t TickType_t;
typedef uint8_t StackType_t;
typedef struct StaticTask {
  uintptr_t opaque[4];
} StaticTask_t;
struct iterate_kit_fake_task;
typedef struct iterate_kit_fake_task *TaskHandle_t;
typedef void (*TaskFunction_t)(void *context);

enum {
  pdFALSE = 0,
  pdTRUE = 1,
};

#define pdMS_TO_TICKS(milliseconds) ((TickType_t)(milliseconds))
#define CONFIG_FREERTOS_NUMBER_OF_CORES 2
/*
 * Capacity appears only in the transport's evidence-labelled metrics. Its
 * exact host value is irrelevant, but defining the target-style Kconfig
 * symbol keeps the production metrics branch compiled and type-checked.
 */
#define CONFIG_LWIP_TCP_SND_BUF_DEFAULT 5744

TaskHandle_t xTaskCreateStaticPinnedToCore(
    TaskFunction_t function,
    const char *name,
    uint32_t stack_depth,
    void *context,
    unsigned int priority,
    StackType_t *stack,
    StaticTask_t *task_storage,
    int core_id);
void xTaskNotifyGive(TaskHandle_t task);
uint32_t ulTaskNotifyTake(
    int clear_count_on_exit, TickType_t timeout_ticks);
uint32_t uxTaskGetStackHighWaterMark(TaskHandle_t task);
void vTaskDelay(TickType_t ticks);
void vTaskDelete(TaskHandle_t task);

/**
 * Delivers one complete or partial text frame through the registered ESP-IDF
 * callback. `payload_length` may exceed `data_length`; this mirrors ESP-IDF's
 * first fragment metadata and lets tests reject an oversized message without
 * allocating an oversized host buffer.
 */
esp_err_t iterate_kit_fake_websocket_emit_text(
    esp_websocket_client_handle_t client,
    const char *data,
    size_t data_length,
    size_t payload_length,
    size_t payload_offset,
    bool fin);

/**
 * When enabled before fixture start, client_start leaves CONNECTED pending so
 * a test can deliver it from the callback thread and poll in the intervening
 * production-shaped window.
 */
void iterate_kit_fake_websocket_defer_connected(bool enabled);
esp_err_t iterate_kit_fake_websocket_emit_connected(
    esp_websocket_client_handle_t client);

/** Makes exactly the next text send return one byte short. */
void iterate_kit_fake_websocket_short_next_send(void);

/**
 * Holds/releases the fake network task at its FreeRTOS notification boundary.
 * Callback injection remains live, allowing deterministic tests of several
 * platform callbacks racing one owner-task recovery decision.
 */
esp_err_t iterate_kit_fake_network_task_pause(void);
esp_err_t iterate_kit_fake_network_task_resume(void);

/** Returns the affinity requested for the currently created fake task. */
int iterate_kit_fake_network_task_core_id(void);

/**
 * Joins and releases the host thread after production stop() has proved its
 * task deleted. ESP-IDF client destruction must not secretly own this join:
 * doing so would hide a production self-join/use-after-delete ordering bug.
 */
esp_err_t iterate_kit_fake_platform_finish(void);

#ifdef __cplusplus
}
#endif

#endif
