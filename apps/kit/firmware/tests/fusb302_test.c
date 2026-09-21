#include "iterate/kit/platforms/fusb302.h"
#include <assert.h>
#include <string.h>

struct bus {
  uint8_t regs[256], rx[512], tx[40];
  size_t rx_read, rx_length, tx_length;
  unsigned sends, operations;
  bool reverse, detached, fail_io;
};

static bool read_bus(void *context, uint8_t reg, uint8_t *out, size_t n) {
  struct bus *bus = context;
  ++bus->operations;
  if (bus->fail_io) return false;
  if (reg == 0x43) {
    assert(bus->rx_read + n <= bus->rx_length);
    memcpy(out, bus->rx + bus->rx_read, n);
    bus->rx_read += n;
    return true;
  }
  memcpy(out, bus->regs + reg, n);
  if (reg == 0x40 || reg == 0x3C) {
    const bool measured_cc1 = bus->regs[2] == 7;
    const uint8_t current = measured_cc1 != bus->reverse ? 3 : 0;
    out[reg == 0x40 ? 0 : 4] = (uint8_t)((bus->detached ? 0 : 0x80) | current);
  }
  if (reg == 0x3C || reg == 0x41) {
    out[reg == 0x41 ? 0 : 5] = bus->rx_read == bus->rx_length ? 0x20 : 0;
  }
  if (reg == 0x3C) bus->regs[0x3E] = 0; /* clear-on-read interrupts */
  return true;
}

static bool write_bus(void *context, uint8_t reg, const uint8_t *in, size_t n) {
  struct bus *bus = context;
  ++bus->operations;
  if (bus->fail_io) return false;
  if (reg == 0x43) {
    assert(n <= sizeof(bus->tx));
    memcpy(bus->tx, in, n);
    bus->tx_length = n;
    ++bus->sends;
  } else {
    memcpy(bus->regs + reg, in, n);
  }
  return true;
}

static void message(struct bus *bus, uint8_t type, uint8_t id, const uint32_t *data, unsigned count) {
  const uint16_t header = (uint16_t)(type | 0x140U | (id << 9) | (count << 12));
  bus->rx[bus->rx_length++] = 0xE0;
  bus->rx[bus->rx_length++] = (uint8_t)header;
  bus->rx[bus->rx_length++] = (uint8_t)(header >> 8);
  for (unsigned i = 0; i < count; ++i) {
    for (unsigned b = 0; b < 4; ++b) bus->rx[bus->rx_length++] = (uint8_t)(data[i] >> (b * 8));
  }
  for (unsigned i = 0; i < 4; ++i) bus->rx[bus->rx_length++] = 0;
}

static void start(struct iterate_kit_fusb302 *pd, struct bus *bus, bool reverse) {
  *bus = (struct bus){.reverse = reverse};
  bus->regs[1] = 0x91;
  const struct iterate_kit_fusb302_io io = {.context = bus, .read = read_bus, .write = write_bus};
  assert(iterate_kit_fusb302_start(pd, &io,
      (struct iterate_kit_pd_limits){20000, 3000, 30000}, 0));
  iterate_kit_fusb302_poll(pd, 10);
  iterate_kit_fusb302_poll(pd, 20);
  assert(pd->status.state == ITERATE_KIT_PD_SEARCHING);
  assert(pd->status.cc == (reverse ? 2 : 1));
  assert(bus->regs[3] == (reverse ? 0x26 : 0x25)); /* Rd + AUTO_CRC, never Rp/VCONN */
}

/* Literal source capabilities: 5V/3A, 9V/3A, 15V/3A, 20V/5A.
 * Our cable/board limit is 3A and 30W, so request PDO 4 at 20V/1.5A. */
static const uint32_t charger[] = {0x0001912C, 0x0002D12C, 0x0004B12C, 0x000641F4};

static void contract(struct iterate_kit_fusb302 *pd, struct bus *bus) {
  message(bus, 1, 0, charger, 4);
  iterate_kit_fusb302_poll(pd, 30);
  assert(pd->status.state == ITERATE_KIT_PD_REQUESTED);
  assert(pd->status.millivolts == 0); /* An offer is not a power supply. */
  const uint8_t expected[] = {
    0x12, 0x12, 0x12, 0x13, 0x86, 0x42, 0x10,
    0x96, 0x58, 0x02, 0x43, 0xFF, 0x14, 0xFE, 0xA1,
  };
  assert(bus->tx_length == sizeof(expected));
  assert(memcmp(bus->tx, expected, sizeof(expected)) == 0);
  bus->regs[0x3E] = 4; /* PHY acknowledged our request. */
  message(bus, 1, 0, NULL, 0); /* same acknowledgment also in RX */
  message(bus, 3, 1, NULL, 0);
  iterate_kit_fusb302_poll(pd, 35);
  assert(pd->tx_id == 1); /* exactly once, not once per acknowledgment representation */
  assert(pd->status.state == ITERATE_KIT_PD_TRANSITION);
  assert(pd->status.millivolts == 0);
  message(bus, 6, 2, NULL, 0);
  iterate_kit_fusb302_poll(pd, 100);
  assert(pd->status.state == ITERATE_KIT_PD_READY);
  assert(pd->status.millivolts == 20000 && pd->status.milliamps == 1500);
  assert(pd->status.contracts == 1);
  message(bus, 6, 2, NULL, 0); /* retransmitted PS_RDY does not publish twice */
  iterate_kit_fusb302_poll(pd, 105);
  assert(pd->status.contracts == 1);
}

static void power_and_resets(void) {
  struct iterate_kit_fusb302 pd;
  struct bus bus;
  start(&pd, &bus, false);
  contract(&pd, &bus);
  message(&bus, 10, 3, NULL, 0); /* reject a power-role swap */
  iterate_kit_fusb302_poll(&pd, 110);
  assert((bus.tx[5] & 31U) == 4);
  assert((bus.tx[6] & 1U) == 0); /* remains a sink */
  bus.regs[0x3E] = 4;
  message(&bus, 1, pd.tx_id, NULL, 0);
  iterate_kit_fusb302_poll(&pd, 115);
  message(&bus, 13, 4, NULL, 0);
  iterate_kit_fusb302_poll(&pd, 120);
  assert(pd.status.state == ITERATE_KIT_PD_SEARCHING && pd.status.millivolts == 0);
  assert(bus.tx[5] == 0x43 && bus.tx[6] == 0); /* Accept with reset message ID */
  assert(pd.status.soft_resets == 1);
  bus.regs[0x3E] = 1;
  iterate_kit_fusb302_poll(&pd, 125);
  assert(pd.status.hard_resets == 1 && pd.status.millivolts == 0);
  bus.regs[0x3E] = 1;
  iterate_kit_fusb302_poll(&pd, 130);
  assert(pd.status.failure == ITERATE_KIT_PD_FAILURE_RESETS);
  const unsigned stopped = bus.operations;
  iterate_kit_fusb302_poll(&pd, 10000);
  assert(bus.operations == stopped);
  start(&pd, &bus, true);
  contract(&pd, &bus);
  bus.detached = true;
  iterate_kit_fusb302_poll(&pd, 110);
  assert(pd.status.state == ITERATE_KIT_PD_DISCONNECTED && pd.status.millivolts == 0);
  bus.detached = false;
  iterate_kit_fusb302_poll(&pd, 360);
  iterate_kit_fusb302_poll(&pd, 370);
  assert(pd.status.state == ITERATE_KIT_PD_SEARCHING);
}

static void usb_only_is_bounded(void) {
  struct iterate_kit_fusb302 pd;
  struct bus bus;
  start(&pd, &bus, false);
  for (unsigned ms = 25; ms < 5000; ms += 5) iterate_kit_fusb302_poll(&pd, ms);
  assert(pd.status.state == ITERATE_KIT_PD_USB_ONLY);
  assert(pd.status.millivolts == 5000 && pd.status.milliamps == 3000);
  assert(pd.status.failure == ITERATE_KIT_PD_FAILURE_NONE && pd.status.i2c_failures == 0);
  assert(bus.sends == 2);
}

static void invalid_and_failed_negotiation(void) {
  struct iterate_kit_fusb302 pd;
  struct bus bus;
  start(&pd, &bus, false);
  /* Fixed 28V, variable supply and PPS are not eligible. */
  const uint32_t unsupported[] = {0x0008C12C, 0x8006412C, 0xC0DC213C};
  message(&bus, 1, 0, unsupported, 3);
  iterate_kit_fusb302_poll(&pd, 30);
  assert(pd.status.failure == ITERATE_KIT_PD_FAILURE_NO_OFFER && bus.sends == 0);
  start(&pd, &bus, false);
  message(&bus, 1, 0, charger, 4);
  iterate_kit_fusb302_poll(&pd, 30);
  bus.regs[0x3E] = 4;
  message(&bus, 1, pd.tx_id, NULL, 0);
  message(&bus, 4, 1, NULL, 0);
  iterate_kit_fusb302_poll(&pd, 35);
  assert(pd.status.failure == ITERATE_KIT_PD_FAILURE_REJECTED);
  start(&pd, &bus, false);
  message(&bus, 1, 0, charger, 4);
  iterate_kit_fusb302_poll(&pd, 30);
  bus.regs[0x3E] = 4;
  message(&bus, 1, pd.tx_id, NULL, 0);
  message(&bus, 3, 1, NULL, 0);
  iterate_kit_fusb302_poll(&pd, 35);
  iterate_kit_fusb302_poll(&pd, 636); /* accepted but never switched */
  assert(pd.status.failure == ITERATE_KIT_PD_FAILURE_TIMEOUT && pd.status.millivolts == 0);
  start(&pd, &bus, false);
  message(&bus, 6, 1, NULL, 0); /* PS_RDY without an accepted request */
  iterate_kit_fusb302_poll(&pd, 30);
  assert(pd.status.failure == ITERATE_KIT_PD_FAILURE_PROTOCOL);
  start(&pd, &bus, false);
  bus.fail_io = true;
  iterate_kit_fusb302_poll(&pd, 30);
  assert(pd.status.failure == ITERATE_KIT_PD_FAILURE_IO && pd.status.i2c_failures == 1);
  iterate_kit_fusb302_poll(&pd, 40);
  assert(pd.status.i2c_failures == 1);
}

static void discovery_ack_and_board_limits(void) {
  struct iterate_kit_fusb302 pd;
  struct bus bus;
  start(&pd, &bus, false);
  iterate_kit_fusb302_poll(&pd, 420); /* Get_Source_Cap ID 0 */
  assert(pd.tx_pending && pd.tx_id == 0);
  message(&bus, 1, 0, NULL, 0);
  message(&bus, 1, 0, charger, 4);
  iterate_kit_fusb302_poll(&pd, 425); /* Request ID 1, before TXSENT is observed */
  assert(pd.tx_pending && pd.tx_id == 1);
  bus.regs[0x3E] = 4; /* delayed latch for ID 0 */
  message(&bus, 1, 0, NULL, 0); /* duplicate acknowledgment for ID 0 */
  iterate_kit_fusb302_poll(&pd, 430);
  assert(pd.tx_pending && pd.tx_id == 1);
  message(&bus, 1, 1, NULL, 0);
  message(&bus, 3, 1, NULL, 0);
  iterate_kit_fusb302_poll(&pd, 435);
  message(&bus, 6, 2, NULL, 0);
  iterate_kit_fusb302_poll(&pd, 500);
  assert(pd.status.state == ITERATE_KIT_PD_READY && pd.tx_id == 2);

  start(&pd, &bus, false);
  pd.limits = (struct iterate_kit_pd_limits){9000, 2000, 12000};
  message(&bus, 1, 0, charger, 4);
  iterate_kit_fusb302_poll(&pd, 30);
  assert(pd.requested_mv == 9000 && pd.requested_ma == 1330);
  start(&pd, &bus, false);
  pd.limits = (struct iterate_kit_pd_limits){20000, 1000, 30000};
  message(&bus, 1, 0, charger, 4);
  iterate_kit_fusb302_poll(&pd, 30);
  assert(pd.requested_mv == 20000 && pd.requested_ma == 1000);
}

int main(void) {
  power_and_resets();
  usb_only_is_bounded();
  invalid_and_failed_negotiation();
  discovery_ack_and_board_limits();
  return 0;
}
