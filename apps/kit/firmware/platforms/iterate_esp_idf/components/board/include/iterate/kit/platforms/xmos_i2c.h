#ifndef ITERATE_KIT_PLATFORMS_XMOS_I2C_H
#define ITERATE_KIT_PLATFORMS_XMOS_I2C_H

#include "driver/i2c_master.h"
#include "iterate/kit/xmos_control.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Write a cumulative tap, then read it back and fail on mismatch: a write
 * ACK alone does not establish the live stage after XMOS reset. Uses the
 * pure xmos_control command/response contract and 50 ms I2C operations.
 */
esp_err_t iterate_kit_xmos_i2c_configure_pipeline(
    i2c_master_dev_handle_t device, uint8_t channel, enum iterate_kit_xmos_stage stage);
/** Read the DSP's voice-to-noise estimate (0..255), without inventing a value
 * on failure. NULL device is UNAVAILABLE before bring-up; NULL out is invalid.
 * Transmit and receive remain separate 50 ms operations, as on HAVPE.
 */
enum iterate_kit_status iterate_kit_xmos_i2c_read_vnr(
    i2c_master_dev_handle_t device, uint8_t *vnr);
/** Verify the pinned firmware before starting blocking slave-I2S tasks. An unbooted
 * XMOS supplies no BCLK and would leave blocking audio stuck; unsupported or
 * malformed responses fail closed with ESP_ERR_INVALID_VERSION.
 */
esp_err_t iterate_kit_xmos_i2c_verify_version(
    i2c_master_dev_handle_t device, struct iterate_kit_xmos_version *version);

#ifdef __cplusplus
}
#endif
#endif
