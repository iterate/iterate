#ifndef ITERATE_KIT_PLATFORMS_TAS2780_REGISTERS_H
#define ITERATE_KIT_PLATFORMS_TAS2780_REGISTERS_H

#include "iterate/kit/platforms/register_write.h"
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Supported supply configurations; NONE is no valid supply (health: 255).
 * Satellite1-ESPHome tas2780.cpp:161-165,250-255,363-375. */
enum iterate_kit_tas2780_power_mode {
  ITERATE_KIT_TAS2780_POWER_MODE_0 = 0,
  ITERATE_KIT_TAS2780_POWER_MODE_2 = 2,
  ITERATE_KIT_TAS2780_POWER_MODE_NONE = 255,
};

/** DVC mute code, Satellite1-ESPHome tas2780.cpp:565-570. */
enum { ITERATE_KIT_TAS2780_DVC_MUTE = 0xC9 };

/** Latched interrupt masks from tas2780.cpp:228-248,445-521.
 * Bits 0..7 are register 0x49; 8..15 are 0x4A; 16..23 are 0x4B;
 * 24..31 are 0x4F. LDMODE retains its two-bit value; reserved bits are zero.
 * LIMA/VBATLIM/LDC etc. are status indications, not necessarily defects. */
enum iterate_kit_tas2780_fault {
  ITERATE_KIT_TAS2780_FAULT_IR_OT = 1U << 0,
  ITERATE_KIT_TAS2780_FAULT_IR_OC = 1U << 1,
  ITERATE_KIT_TAS2780_FAULT_IR_TDMCE = 1U << 2,
  ITERATE_KIT_TAS2780_FAULT_IR_LIMA = 1U << 3,
  ITERATE_KIT_TAS2780_FAULT_IR_PBIP = 1U << 4,
  ITERATE_KIT_TAS2780_FAULT_IR_LIMMA = 1U << 5,
  ITERATE_KIT_TAS2780_FAULT_IR_BOPIH = 1U << 6,
  ITERATE_KIT_TAS2780_FAULT_IR_BOPM = 1U << 7,
  ITERATE_KIT_TAS2780_FAULT_IR_VBATLIM = 1U << 8,
  ITERATE_KIT_TAS2780_FAULT_IR_LDMODE = 3U << 11,
  ITERATE_KIT_TAS2780_FAULT_IR_LDC = 1U << 13,
  ITERATE_KIT_TAS2780_FAULT_IR_OTPCRC = 1U << 14,
  ITERATE_KIT_TAS2780_FAULT_IR_VBAT1S_UVLO = 1U << 21,
  ITERATE_KIT_TAS2780_FAULT_IR_PLL_CLK = 1U << 23,
  ITERATE_KIT_TAS2780_FAULT_IR_PUVLO = 1U << 24,
  ITERATE_KIT_TAS2780_FAULT_IR_LDO_OL = 1U << 25,
  ITERATE_KIT_TAS2780_FAULT_IR_LDO_OV = 1U << 26,
  ITERATE_KIT_TAS2780_FAULT_IR_LDO_UV = 1U << 27,
};

/** Mode-independent writes in order; count may be NULL. Translation of
 * tas2780.cpp:277-338,592-598; mono down-mix, 32-bit words and slots. */
const struct iterate_kit_register_write *iterate_kit_tas2780_base_script(size_t *count);
/** Clamp percent to 100, then (100-percent)*2; task step 17 / tas2780.cpp:574-590. */
uint8_t iterate_kit_tas2780_dvc_for_percent(uint8_t percent);
/** PVDD >= 740 selects mode 2; otherwise 290 < VBAT1S <= 550 selects
 * mode 0; else NONE. Centivolts, tas2780.cpp:161-165,363-375. */
enum iterate_kit_tas2780_power_mode iterate_kit_tas2780_power_mode_for(
    uint16_t pvdd_centivolts, uint16_t vbat1s_centivolts);
/** Build 0x03/0x04/0x71 writes, preserving unrelated bits, AMP_LEVEL=8
 * (15 dBV). False leaves out unchanged for NONE/NULL. tas2780.cpp:427-443,592-598. */
bool iterate_kit_tas2780_power_registers(
    enum iterate_kit_tas2780_power_mode mode, uint8_t chnl_0, uint8_t dc_blk0,
    struct iterate_kit_register_write out[3]);
/** Decode left-justified 12-bit SAR, tas2780.cpp:399-425. */
uint16_t iterate_kit_tas2780_sar_raw(uint8_t msb, uint8_t lsb);
/** VBAT1S SAR in centivolts, truncated after raw*100/128; tas2780.cpp:422. */
uint16_t iterate_kit_tas2780_vbat1s_centivolts(uint8_t msb, uint8_t lsb);
/** PVDD SAR in centivolts, truncated after raw*100/64; tas2780.cpp:423. */
uint16_t iterate_kit_tas2780_pvdd_centivolts(uint8_t msb, uint8_t lsb);
/** Decode the four latches into the documented masks; tas2780.cpp:445-521. */
uint32_t iterate_kit_tas2780_decode_faults(
    uint8_t latch_0, uint8_t latch_1, uint8_t latch_1_0, uint8_t latch_2);

#ifdef __cplusplus
}
#endif
#endif
