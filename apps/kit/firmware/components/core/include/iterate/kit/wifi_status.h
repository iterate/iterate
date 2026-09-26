#ifndef ITERATE_KIT_WIFI_STATUS_H
#define ITERATE_KIT_WIFI_STATUS_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Where a board's own network stands, below iterate, in words the shared loop
 * can use on every platform. Each platform's transport metrics carry one
 * (`wifi_status`); a platform with no Wi-Fi to join (the Mac) always reports
 * JOINED, which is also the zero value.
 */
enum iterate_kit_wifi_status {
  ITERATE_KIT_WIFI_JOINED = 0,
  /** Joining, with no reason yet to think it will not work. */
  ITERATE_KIT_WIFI_JOINING,
  /** The access point refused the password (or the handshake never finished). */
  ITERATE_KIT_WIFI_WRONG_PASSWORD,
  /** No access point with the configured name answered. */
  ITERATE_KIT_WIFI_NOT_FOUND,
};

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_WIFI_STATUS_H */
