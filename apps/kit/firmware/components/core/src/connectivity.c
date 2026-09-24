#include "iterate/kit/connectivity.h"

#include <stddef.h>

enum iterate_kit_connectivity iterate_kit_connectivity_update(
    struct iterate_kit_connectivity_tracker *tracker,
    uint64_t now_ms,
    bool online,
    enum iterate_kit_network_stage stage) {
  if (online) {
    tracker->counting = false;
    return ITERATE_KIT_CONNECTIVITY_ONLINE;
  }
  if (!tracker->counting) {
    tracker->counting = true;
    tracker->not_online_since_ms = now_ms;
  }
  const uint64_t elapsed_ms = now_ms > tracker->not_online_since_ms
      ? now_ms - tracker->not_online_since_ms : 0U;
  if (elapsed_ms < ITERATE_KIT_CONNECTIVITY_OFFLINE_AFTER_MS) {
    return ITERATE_KIT_CONNECTIVITY_CONNECTING;
  }
  switch (stage) {
    case ITERATE_KIT_NETWORK_STAGE_JOINING_WIFI: return ITERATE_KIT_CONNECTIVITY_NO_WIFI;
    case ITERATE_KIT_NETWORK_STAGE_REACHING_HOST: return ITERATE_KIT_CONNECTIVITY_NO_INTERNET;
    case ITERATE_KIT_NETWORK_STAGE_REACHING_ITERATE: return ITERATE_KIT_CONNECTIVITY_NO_ITERATE;
  }
  return ITERATE_KIT_CONNECTIVITY_NO_ITERATE;
}

bool iterate_kit_connectivity_offline(enum iterate_kit_connectivity connectivity) {
  return connectivity == ITERATE_KIT_CONNECTIVITY_NO_WIFI ||
      connectivity == ITERATE_KIT_CONNECTIVITY_NO_INTERNET ||
      connectivity == ITERATE_KIT_CONNECTIVITY_NO_ITERATE;
}

const char *iterate_kit_connectivity_name(enum iterate_kit_connectivity connectivity) {
  switch (connectivity) {
    case ITERATE_KIT_CONNECTIVITY_ONLINE: return "online";
    case ITERATE_KIT_CONNECTIVITY_CONNECTING: return "connecting";
    case ITERATE_KIT_CONNECTIVITY_NO_WIFI: return "no-wifi";
    case ITERATE_KIT_CONNECTIVITY_NO_INTERNET: return "no-internet";
    case ITERATE_KIT_CONNECTIVITY_NO_ITERATE: return "no-iterate";
  }
  return "?";
}

const char *iterate_kit_connectivity_status(enum iterate_kit_connectivity connectivity) {
  switch (connectivity) {
    case ITERATE_KIT_CONNECTIVITY_NO_WIFI: return "couldn't join the Wi-Fi network";
    case ITERATE_KIT_CONNECTIVITY_NO_INTERNET: return "couldn't connect to the internet";
    case ITERATE_KIT_CONNECTIVITY_NO_ITERATE: return "couldn't reach iterate";
    case ITERATE_KIT_CONNECTIVITY_ONLINE:
    case ITERATE_KIT_CONNECTIVITY_CONNECTING: return NULL;
  }
  return NULL;
}
