#ifndef ITERATE_KIT_FUSB302_H
#define ITERATE_KIT_FUSB302_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Fixed-supply USB-PD 2.0 sink, using the FUSB302B PHY. No source role,
 * voltage forcing, PPS or EPR. Limits belong to the board, not the charger.
 * Register/framing reference: onsemi FUSB302B/D; Satellite1-ESPHome
 * esphome/components/fusb302b at 9814bf5 (GPL-3.0). */
enum iterate_kit_pd_state {
  ITERATE_KIT_PD_SEARCHING,
  ITERATE_KIT_PD_USB_ONLY,
  ITERATE_KIT_PD_REQUESTED,
  ITERATE_KIT_PD_TRANSITION,
  ITERATE_KIT_PD_READY,
  ITERATE_KIT_PD_DISCONNECTED,
  ITERATE_KIT_PD_FAILED,
};

enum iterate_kit_pd_failure {
  ITERATE_KIT_PD_FAILURE_NONE,
  ITERATE_KIT_PD_FAILURE_IO,
  ITERATE_KIT_PD_FAILURE_CHIP_ID,
  ITERATE_KIT_PD_FAILURE_NO_OFFER,
  ITERATE_KIT_PD_FAILURE_REJECTED,
  ITERATE_KIT_PD_FAILURE_TIMEOUT,
  ITERATE_KIT_PD_FAILURE_PROTOCOL,
  ITERATE_KIT_PD_FAILURE_RESETS,
  ITERATE_KIT_PD_FAILURE_TASK,
};

struct iterate_kit_pd_limits {
  uint16_t millivolts;  /* 5000..20000, fixed SPR only */
  uint16_t milliamps;  /* <=3000: no cable discovery is required */
  uint32_t milliwatts;
};

struct iterate_kit_pd_status {
  enum iterate_kit_pd_state state;
  enum iterate_kit_pd_failure failure;
  uint16_t millivolts; /* explicit contract only after Accept AND PS_RDY */
  uint16_t milliamps;
  uint32_t contracts;
  uint32_t hard_resets;
  uint32_t soft_resets;
  uint32_t i2c_failures;
  uint32_t messages;
  uint8_t cc;
};

struct iterate_kit_fusb302_io {
  void *context;
  bool (*read)(void *context, uint8_t reg, uint8_t *bytes, size_t length);
  bool (*write)(void *context, uint8_t reg, const uint8_t *bytes, size_t length);
};

/* Owned by one task. poll must run at least every 5 ms while negotiating;
 * GoodCRC and three retransmissions run in the PHY. No waits or allocations.
 * Two discovery probes, at most two resets, and a deadline bound each exchange.
 * A non-PD computer port is USB_ONLY, not an error or a retry loop. */
struct iterate_kit_fusb302 {
  struct iterate_kit_fusb302_io io;
  struct iterate_kit_pd_limits limits;
  struct iterate_kit_pd_status status;
  uint64_t deadline_ms;
  uint64_t probe_ms;
  uint64_t tx_deadline_ms;
  uint16_t requested_mv, requested_ma;
  uint8_t stage, cc1, tx_id, rx_id, probes, recoveries;
  bool tx_pending, source_seen, soft_reset_sent;
};

bool iterate_kit_fusb302_start(struct iterate_kit_fusb302 *pd,
    const struct iterate_kit_fusb302_io *io,
    struct iterate_kit_pd_limits limits, uint64_t now_ms);
void iterate_kit_fusb302_poll(struct iterate_kit_fusb302 *pd, uint64_t now_ms);

#endif
