#ifndef ITERATE_KIT_CONNECTIVITY_H
#define ITERATE_KIT_CONNECTIVITY_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * WHETHER THE DEVICE CAN GET ONLINE, AND IF NOT, WHERE IT GETS STUCK.
 *
 * A board flashed with the wrong Wi-Fi password used to look like a broken
 * voice agent: it said "connecting to iterate", started a call on the wake
 * word, and said "Call ended." twenty seconds later. Its transport knew the
 * whole time that it had never joined the network.
 *
 * Each platform's transport reports how far its newest attempt got (a stage).
 * This turns the stage, plus how long the device has gone without a mounted
 * session, into a verdict the voice loop shows and speaks. The transport keeps
 * retrying whatever the verdict says, and mounting clears it at once.
 */

/** How far the newest attempt to reach iterate got; each transport reports it. */
enum iterate_kit_network_stage {
  /** No IP lease: wrong password, network not visible (e.g. 5 GHz only). */
  ITERATE_KIT_NETWORK_STAGE_JOINING_WIFI = 0,
  /** An IP lease, but DNS, TCP or TLS to the platform's host did not get through. */
  ITERATE_KIT_NETWORK_STAGE_REACHING_HOST,
  /**
   * The host answered, but refused the WebSocket upgrade (a deleted preview
   * answers 404) or the session has not mounted this device.
   */
  ITERATE_KIT_NETWORK_STAGE_REACHING_ITERATE,
};

/** What the person is told about the connection. */
enum iterate_kit_connectivity {
  /** The session is mounted; a call can start. */
  ITERATE_KIT_CONNECTIVITY_ONLINE = 0,
  /** Not mounted, but not for long enough to call it a failure. */
  ITERATE_KIT_CONNECTIVITY_CONNECTING,
  ITERATE_KIT_CONNECTIVITY_NO_WIFI,
  ITERATE_KIT_CONNECTIVITY_NO_INTERNET,
  ITERATE_KIT_CONNECTIVITY_NO_ITERATE,
};

enum {
  /*
   * How long without a mount before the device says it is offline. Joining
   * Wi-Fi, TLS and the mount take a few seconds at boot, and a dropped socket
   * normally comes back within a few more; neither should be announced. A
   * wrong Wi-Fi password fails two or three joins inside this window.
   */
  ITERATE_KIT_CONNECTIVITY_OFFLINE_AFTER_MS = 15000,
};

/** Zero-initialize once; the voice loop's app task is the only caller. */
struct iterate_kit_connectivity_tracker {
  /** When the current stretch without a mount began. */
  uint64_t not_online_since_ms;
  /** True while that stretch is running; false before the first update and while online. */
  bool counting;
};

/**
 * One pass: `online` is "the session is mounted", `stage` the transport's
 * newest attempt. Returns ONLINE at once when online, CONNECTING for the first
 * ITERATE_KIT_CONNECTIVITY_OFFLINE_AFTER_MS without a mount (counted from the
 * first call, which is boot), and the stage's verdict after that.
 */
enum iterate_kit_connectivity iterate_kit_connectivity_update(
    struct iterate_kit_connectivity_tracker *tracker,
    uint64_t now_ms,
    bool online,
    enum iterate_kit_network_stage stage);

/** NO_WIFI, NO_INTERNET or NO_ITERATE: a call cannot work, so none starts. */
bool iterate_kit_connectivity_offline(enum iterate_kit_connectivity connectivity);

/** "online", "connecting", "no-wifi", "no-internet", "no-iterate": for logs and health. */
const char *iterate_kit_connectivity_name(enum iterate_kit_connectivity connectivity);

/**
 * The status line a screen shows for an offline verdict, or NULL for ONLINE
 * and CONNECTING. A string literal, so a board may keep the pointer.
 */
const char *iterate_kit_connectivity_status(enum iterate_kit_connectivity connectivity);

#ifdef __cplusplus
}
#endif

#endif
