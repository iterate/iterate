/* FUSB302B register/framing translation from FutureProofHomes
 * Satellite1-ESPHome 9814bf5 (GPL-3.0); bounded fixed-supply sink policy. */
#include "iterate/kit/platforms/fusb302.h"

enum {
  DEVICE_ID = 0x01, SWITCHES0 = 0x02, SWITCHES1 = 0x03, MEASURE = 0x04,
  CONTROL0 = 0x06, CONTROL1 = 0x07, CONTROL3 = 0x09, MASK = 0x0A,
  POWER = 0x0B, RESET = 0x0C, MASKA = 0x0E, MASKB = 0x0F,
  STATUS0A = 0x3C, STATUS0 = 0x40, STATUS1 = 0x41, FIFO = 0x43,
  GOODCRC = 1, ACCEPT = 3, REJECT = 4, PS_RDY = 6, GET_SOURCE_CAP = 7,
  GET_SINK_CAP = 8, WAIT = 12, SOFT_RESET = 13,
  SOURCE_CAP = 1, REQUEST = 2, SINK_CAP = 4,
};

static void increment(uint32_t *value) {
  if (*value != UINT32_MAX) ++*value;
}

static void fail(struct iterate_kit_fusb302 *pd, enum iterate_kit_pd_failure reason) {
  pd->status.state = ITERATE_KIT_PD_FAILED;
  pd->status.failure = reason;
  pd->status.millivolts = 0;
  pd->status.milliamps = 0;
  pd->tx_pending = false;
}

static bool read_bytes(struct iterate_kit_fusb302 *pd, uint8_t reg, uint8_t *out, size_t n) {
  if (pd->io.read(pd->io.context, reg, out, n)) return true;
  increment(&pd->status.i2c_failures);
  fail(pd, ITERATE_KIT_PD_FAILURE_IO);
  return false;
}

static bool write_bytes(struct iterate_kit_fusb302 *pd, uint8_t reg, const uint8_t *in, size_t n) {
  if (pd->io.write(pd->io.context, reg, in, n)) return true;
  increment(&pd->status.i2c_failures);
  fail(pd, ITERATE_KIT_PD_FAILURE_IO);
  return false;
}

static bool write_reg(struct iterate_kit_fusb302 *pd, uint8_t reg, uint8_t value) {
  return write_bytes(pd, reg, &value, 1);
}

static bool reset_protocol(struct iterate_kit_fusb302 *pd) {
  pd->tx_id = 0;
  pd->rx_id = 255;
  pd->tx_pending = false;
  return write_reg(pd, CONTROL0, 0x40) && write_reg(pd, CONTROL1, 0x04) &&
      write_reg(pd, RESET, 0x02);
}

static bool send_message(struct iterate_kit_fusb302 *pd, uint8_t type,
    const uint32_t *object, uint64_t now) {
  if (pd->tx_pending) {
    fail(pd, ITERATE_KIT_PD_FAILURE_PROTOCOL);
    return false;
  }
  const uint16_t header = (uint16_t)(type | 0x40U | (pd->tx_id << 9) |
      (object != NULL ? 0x1000U : 0U)); /* PD2, UFP, sink */
  uint8_t bytes[15] = {0x12, 0x12, 0x12, 0x13,
      (uint8_t)(object != NULL ? 0x86 : 0x82), (uint8_t)header, (uint8_t)(header >> 8)};
  size_t n = 7;
  if (object != NULL) {
    for (unsigned i = 0; i < 4; ++i) bytes[n++] = (uint8_t)(*object >> (i * 8));
  }
  bytes[n++] = 0xFF; /* JAM_CRC */
  bytes[n++] = 0x14; /* EOP */
  bytes[n++] = 0xFE; /* TXOFF */
  bytes[n++] = 0xA1; /* TXON */
  if (!write_bytes(pd, FIFO, bytes, n)) return false;
  pd->tx_pending = true;
  pd->tx_deadline_ms = now + 100;
  return true;
}

static bool request_offer(struct iterate_kit_fusb302 *pd, const uint8_t *objects,
    unsigned count, uint64_t now) {
  uint16_t best_mv = 0, best_ma = 0;
  unsigned position = 0;
  for (unsigned i = 0; i < count; ++i) {
    const uint8_t *p = objects + i * 4;
    const uint32_t pdo = (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
        ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    if ((pdo >> 30) != 0) continue; /* fixed supply only */
    const uint16_t mv = (uint16_t)(((pdo >> 10) & 1023U) * 50U);
    uint16_t ma = (uint16_t)((pdo & 1023U) * 10U);
    if (mv < 5000 || mv > pd->limits.millivolts || ma == 0) continue;
    if (ma > pd->limits.milliamps) ma = pd->limits.milliamps;
    const uint32_t power_ma = pd->limits.milliwatts * 1000U / mv;
    if (ma > power_ma) ma = (uint16_t)power_ma;
    ma = (uint16_t)(ma / 10U * 10U);
    if (ma == 0 || mv < best_mv || (mv == best_mv && ma <= best_ma)) continue;
    best_mv = mv;
    best_ma = ma;
    position = i + 1;
  }
  if (position == 0) {
    fail(pd, ITERATE_KIT_PD_FAILURE_NO_OFFER);
    return false;
  }
  const uint32_t units = best_ma / 10U;
  const uint32_t rdo = (position << 28) | (1U << 25) | (1U << 24) |
      (units << 10) | units;
  if (!send_message(pd, REQUEST, &rdo, now)) return false;
  pd->requested_mv = best_mv;
  pd->requested_ma = best_ma;
  pd->status.state = ITERATE_KIT_PD_REQUESTED;
  pd->status.millivolts = 0;
  pd->status.milliamps = 0;
  pd->deadline_ms = now + 500;
  return true;
}

static void receive_message(struct iterate_kit_fusb302 *pd, uint64_t now) {
  uint8_t prefix[3], data[32];
  if (!read_bytes(pd, FIFO, prefix, sizeof(prefix))) return;
  const uint16_t header = (uint16_t)(prefix[1] | (prefix[2] << 8));
  const unsigned count = (header >> 12) & 7U;
  if (!read_bytes(pd, FIFO, data, count * 4 + 4)) return; /* objects + PHY-checked CRC */
  if ((prefix[0] & 0xE0U) != 0xE0U || (header & 0x8000U) != 0) {
    fail(pd, ITERATE_KIT_PD_FAILURE_PROTOCOL);
    return;
  }
  const uint8_t type = header & 31U;
  const uint8_t id = (header >> 9) & 7U;
  /* Use the FIFO acknowledgment's ID, not the untagged TXSENT interrupt:
   * its latch can arrive after RX has already caused our next transmission. */
  if (count == 0 && type == GOODCRC) {
    if (pd->tx_pending && id == pd->tx_id) {
      pd->tx_id = (pd->tx_id + 1U) & 7U;
      pd->tx_pending = false;
    }
    return;
  }
  if (count == 0 && type == SOFT_RESET) {
    increment(&pd->status.soft_resets);
    if (++pd->recoveries > 2) { fail(pd, ITERATE_KIT_PD_FAILURE_RESETS); return; }
    if (!reset_protocol(pd) || !send_message(pd, ACCEPT, NULL, now)) return;
    pd->status.state = ITERATE_KIT_PD_SEARCHING;
    pd->status.millivolts = 0;
    pd->status.milliamps = 0;
    pd->source_seen = true;
    pd->deadline_ms = now + 1500;
    return;
  }
  if (id == pd->rx_id) return;
  pd->rx_id = id;
  increment(&pd->status.messages);
  if (count > 0) {
    if (type == SOURCE_CAP) {
      pd->source_seen = true;
      (void)request_offer(pd, data, count, now);
    }
    return;
  }
  switch (type) {
    case ACCEPT:
      if (pd->status.state == ITERATE_KIT_PD_REQUESTED) {
        pd->status.state = ITERATE_KIT_PD_TRANSITION;
        pd->deadline_ms = now + 600;
      } else if (pd->soft_reset_sent) {
        pd->soft_reset_sent = false;
        pd->source_seen = true;
      }
      break;
    case PS_RDY:
      if (pd->status.state != ITERATE_KIT_PD_TRANSITION) {
        fail(pd, ITERATE_KIT_PD_FAILURE_PROTOCOL);
        break;
      }
      pd->status.state = ITERATE_KIT_PD_READY;
      pd->status.failure = ITERATE_KIT_PD_FAILURE_NONE;
      pd->status.millivolts = pd->requested_mv;
      pd->status.milliamps = pd->requested_ma;
      increment(&pd->status.contracts);
      break;
    case REJECT:
    case WAIT:
      fail(pd, ITERATE_KIT_PD_FAILURE_REJECTED);
      break;
    case GET_SINK_CAP: {
      const uint32_t sink = (1U << 26) | (1U << 28) | (100U << 10) |
          (pd->limits.milliamps / 10U);
      (void)send_message(pd, SINK_CAP, &sink, now);
      break;
    }
    default:
      /* PD2 Reject, including power/data/VCONN swaps. Never become a source. */
      (void)send_message(pd, REJECT, NULL, now);
      break;
  }
}

bool iterate_kit_fusb302_start(struct iterate_kit_fusb302 *pd,
    const struct iterate_kit_fusb302_io *io,
    struct iterate_kit_pd_limits limits, uint64_t now) {
  if (pd == NULL || io == NULL || io->read == NULL || io->write == NULL ||
      limits.millivolts < 5000 || limits.millivolts > 20000 ||
      limits.milliamps < 10 || limits.milliamps > 3000 ||
      limits.milliwatts < 500 || limits.milliwatts > 60000) return false;
  *pd = (struct iterate_kit_fusb302){.io = *io, .limits = limits, .rx_id = 255};
  uint8_t id;
  if (!read_bytes(pd, DEVICE_ID, &id, 1)) return false;
  if (id != 0x81 && id != 0x91) {
    fail(pd, ITERATE_KIT_PD_FAILURE_CHIP_ID);
    return false;
  }
  if (!write_reg(pd, RESET, 1) || !write_reg(pd, POWER, 15) ||
      !write_reg(pd, MASK, 0x51) || !write_reg(pd, MASKA, 0) ||
      !write_reg(pd, MASKB, 0) || !write_reg(pd, CONTROL3, 7) ||
      !write_reg(pd, SWITCHES1, 0x20) || !write_reg(pd, MEASURE, 49) ||
      !write_reg(pd, SWITCHES0, 7)) return false;
  pd->stage = 1; /* settle CC1; both Rd resistors remain connected */
  pd->deadline_ms = now + 10;
  return true;
}

void iterate_kit_fusb302_poll(struct iterate_kit_fusb302 *pd, uint64_t now) {
  if (pd == NULL || pd->status.state == ITERATE_KIT_PD_FAILED) return;
  uint8_t status;
  if (pd->stage != 0) {
    if (now < pd->deadline_ms) return;
    if (!read_bytes(pd, STATUS0, &status, 1)) return;
    if (pd->stage == 1) {
      pd->cc1 = status & 3U;
      if (!write_reg(pd, SWITCHES0, 11)) return;
      pd->stage = 2;
      pd->deadline_ms = now + 10;
      return;
    }
    const uint8_t cc2 = status & 3U;
    if ((pd->cc1 == 0) == (cc2 == 0)) {
      pd->status.state = ITERATE_KIT_PD_DISCONNECTED;
      if (!write_reg(pd, SWITCHES0, 7)) return;
      pd->stage = 1;
      pd->deadline_ms = now + 250;
      return;
    }
    pd->status.cc = pd->cc1 != 0 ? 1 : 2;
    if (!write_reg(pd, SWITCHES0, pd->status.cc == 1 ? 7 : 11) ||
        !reset_protocol(pd) ||
        !write_reg(pd, SWITCHES1, pd->status.cc == 1 ? 0x25 : 0x26)) return;
    pd->stage = 0;
    pd->status.state = ITERATE_KIT_PD_SEARCHING;
    pd->probes = 0;
    pd->source_seen = false;
    pd->deadline_ms = now + 1800;
    pd->probe_ms = now + 400;
  }
  uint8_t regs[7];
  const bool pending_before_read = pd->tx_pending;
  const uint8_t tx_id_before_read = pd->tx_id;
  if (!read_bytes(pd, STATUS0A, regs, sizeof(regs))) return;
  if ((regs[4] & 0x80U) == 0) { /* VBUS detached; a separately powered board can survive this */
    pd->status.state = ITERATE_KIT_PD_DISCONNECTED;
    pd->status.millivolts = 0;
    pd->status.milliamps = 0;
    pd->recoveries = 0;
    if (!reset_protocol(pd) || !write_reg(pd, SWITCHES1, 0x20) ||
        !write_reg(pd, SWITCHES0, 7)) return;
    pd->stage = 1;
    pd->deadline_ms = now + 250;
    return;
  }
  if ((regs[2] & 1U) != 0) {
    increment(&pd->status.hard_resets);
    if (++pd->recoveries > 2) { fail(pd, ITERATE_KIT_PD_FAILURE_RESETS); return; }
    if (!reset_protocol(pd)) return;
    pd->status.state = ITERATE_KIT_PD_SEARCHING;
    pd->status.millivolts = 0;
    pd->status.milliamps = 0;
    pd->source_seen = true;
    pd->deadline_ms = now + 1800;
    return;
  }
  status = regs[5];
  for (unsigned messages = 0; messages < 8 && (status & 0x20U) == 0; ++messages) {
    receive_message(pd, now);
    if (pd->status.state == ITERATE_KIT_PD_FAILED ||
        !read_bytes(pd, STATUS1, &status, 1)) return;
  }
  const bool retry_failed = pending_before_read && pd->tx_id == tx_id_before_read &&
      (regs[2] & 0x10U) != 0;
  if (pd->tx_pending && (retry_failed || now >= pd->tx_deadline_ms)) {
    pd->tx_pending = false;
    if (pd->source_seen) { fail(pd, ITERATE_KIT_PD_FAILURE_TIMEOUT); return; }
    /* A USB-only source does not acknowledge PD discovery. */
  }
  if (pd->status.state == ITERATE_KIT_PD_READY || pd->status.state == ITERATE_KIT_PD_USB_ONLY) return;
  if (now >= pd->deadline_ms) {
    if (!pd->source_seen) {
      pd->status.state = ITERATE_KIT_PD_USB_ONLY;
      pd->status.millivolts = 5000;
      /* CC current advertisement; default USB remains conservatively 500 mA. */
      const uint8_t current = regs[4] & 3U;
      pd->status.milliamps = current == 3 ? 3000 : current == 2 ? 1500 : 500;
    } else {
      fail(pd, ITERATE_KIT_PD_FAILURE_TIMEOUT);
    }
    return;
  }
  if (pd->status.state == ITERATE_KIT_PD_SEARCHING && !pd->source_seen &&
      !pd->tx_pending && now >= pd->probe_ms && pd->probes < 2) {
    if (pd->probes == 0) {
      if (!send_message(pd, GET_SOURCE_CAP, NULL, now)) return;
    } else {
      if (!reset_protocol(pd) || !send_message(pd, SOFT_RESET, NULL, now)) return;
      pd->soft_reset_sent = true;
    }
    ++pd->probes;
    pd->probe_ms = now + 600;
  }
}
