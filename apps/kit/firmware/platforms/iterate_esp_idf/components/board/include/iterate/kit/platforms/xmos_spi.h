#ifndef ITERATE_KIT_PLATFORMS_XMOS_SPI_H
#define ITERATE_KIT_PLATFORMS_XMOS_SPI_H

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "iterate/kit/platforms/xmos_spi_registers.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Caller-owned transport: open SPI2_HOST, mode 3, 8 MHz, MSB first, full
 * duplex, no hardware CS (spics_io_num=-1). Configure cs_gpio as output HIGH
 * before use; the driver drives it around each transaction. Serialize calls
 * on this handle, including both halves of reads. No ownership of reset:
 * GPIO4 LOW runs XMOS from flash (satellite1.cpp:214-219). SPI facts from
 * satellite1.cpp:118-180 and board-table task step 17. */
struct iterate_kit_xmos_spi {
  spi_device_handle_t device;
  gpio_num_t cs_gpio;
};

/** Send a framed command; BUSY gets at most three retries, one tick apart,
 * on EACH half. For read commands, len must equal reply_len (1..253), payload
 * contains request dummy bytes; wait one tick and clock reply_len+3 zeros.
 * Copy rx[1..] only on DONE, leaving reply unchanged on failure. Writes
 * require reply=NULL, reply_len=0. A status report clocked in during a
 * transfer carries the PREVIOUS command's return code (the slave fills its
 * TX buffer in the transfer-done callback), so it is never this command's
 * verdict and is not treated as failure.
 * Source: satellite1.cpp:118-180; device_control_spi.c:63-90. */
bool iterate_kit_xmos_spi_transfer(struct iterate_kit_xmos_spi *handle,
    uint8_t resource, uint8_t command, const uint8_t *payload, size_t len,
    uint8_t *reply, size_t reply_len);
/** Request resource 240 command 88|0x80, five bytes; at most attempts calls
 * interval_ms apart, with no delay after the last. Zero attempts is false.
 * Output changes only for nonzero version. satellite1.cpp:194-212. */
bool iterate_kit_xmos_spi_read_version(struct iterate_kit_xmos_spi *handle,
    struct iterate_kit_xmos_version *version, uint8_t attempts, uint16_t interval_ms);
/** Send resource 0 command 0 NOP and require a status report; copy four
 * bytes only on success. Only byte 1 is reliable; see classify docstring.
 * Source: device_control_spi.c:63-90 / satellite1.cpp:151-158. */
bool iterate_kit_xmos_spi_read_status(struct iterate_kit_xmos_spi *handle, uint8_t status[4]);

#ifdef __cplusplus
}
#endif
#endif
