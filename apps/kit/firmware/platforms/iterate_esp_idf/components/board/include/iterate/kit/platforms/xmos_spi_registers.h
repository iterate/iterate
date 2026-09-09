#ifndef ITERATE_KIT_PLATFORMS_XMOS_SPI_REGISTERS_H
#define ITERATE_KIT_PLATFORMS_XMOS_SPI_REGISTERS_H

#include "iterate/kit/xmos_control.h"

#ifdef __cplusplus
extern "C" {
#endif

/** SPI reply shapes from Satellite1-ESPHome satellite1.cpp:118-180 and
 * satellite1.h:10-55. ERROR includes the 1,23 payload-available header;
 * only the first half of a read may accept that header and fetch a payload. */
enum iterate_kit_xmos_spi_reply {
  ITERATE_KIT_XMOS_SPI_BUSY,
  ITERATE_KIT_XMOS_SPI_NO_DEVICE,
  ITERATE_KIT_XMOS_SPI_STATUS_REPORT,
  ITERATE_KIT_XMOS_SPI_OK,
  ITERATE_KIT_XMOS_SPI_ERROR,
};

/** XMOS slave buffer bounds, Satellite1-XMOS device_control_spi.c:12-14.
 * Both directions fit 256 bytes, including the three-byte request header. */
enum {
  ITERATE_KIT_XMOS_SPI_FRAME_CAPACITY = 256,
  ITERATE_KIT_XMOS_SPI_MAX_PAYLOAD = 253,
};

/** Build [resource,command,length+read_bit] followed by payload and zeros to
 * at least seven bytes. Payload must not overlap out; NULL is valid only at
 * length 0. Return 0 without writing for NULL/short output or length >253.
 * Source: satellite1.cpp:118-142, device_control_spi.c:12-14; task step 17
 * deliberately pads to 3+4 bytes. Read requests supply zero dummy payload. */
size_t iterate_kit_xmos_spi_frame(uint8_t *out, size_t capacity,
    uint8_t resource, uint8_t command, const uint8_t *payload, size_t payload_length);
/** Classify >=3 bytes, or ERROR if truncated/NULL. STATUS_REPORT needs >=6
 * bytes; copy rx[2..5] only for that shape (output may be NULL).
 * Layout: [0] device, [1] GPIO_IN_A, [2] GPIO_IN_B, [3] GPIO_OUT_A.
 * ONLY byte 1 is trustworthy in the shipped XMOS build: a three-byte buffer
 * is copied as ten bytes. Source: satellite1.cpp:145-158, satellite1.h:40-49,
 * device_control_spi.c:63-90 and board-table task Satellite1 section. */
enum iterate_kit_xmos_spi_reply iterate_kit_xmos_spi_classify(
    const uint8_t *rx, size_t length, uint8_t status_register_out[4]);
/** Parse exactly {major,minor,patch,prerelease,n}; reject all five zero or
 * NULL, leave output unchanged on failure. The shared version stores only
 * the first three fields. Source: satellite1.cpp:194-212; reuse core's parser
 * after supplying its successful device-control status byte. */
bool iterate_kit_xmos_spi_parse_version(const uint8_t *payload, size_t length,
    struct iterate_kit_xmos_version *version);

#ifdef __cplusplus
}
#endif
#endif
