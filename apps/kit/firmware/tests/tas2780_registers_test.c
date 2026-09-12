#include "iterate/kit/platforms/tas2780_registers.h"
#include <assert.h>
#include <string.h>

/* Literal oracle from Satellite1-ESPHome tas2780.cpp:277-338,592-598 and
 * step 17. Record the script exactly as a byte-oriented I2C writer sees it. */
static void iterate_kit_tas2780_test_script(void) {
  const uint8_t expected[][2] = {
    {0x00, 0x00}, {0x01, 0x01}, {0x00, 0x00}, {0x0E, 0x44},
    {0x0F, 0x40}, {0x00, 0x01}, {0x19, 0x00}, {0x17, 0xC8},
    {0x21, 0x00}, {0x35, 0x74}, {0x00, 0xFD}, {0x0D, 0x0D},
    {0x3E, 0x4A}, {0x0D, 0x00}, {0x00, 0x00}, {0x3D, 0xFF},
    {0x40, 0xFF}, {0x41, 0xFF}, {0x3C, 0xFF}, {0x0A, 0x3E},
  };
  size_t count = 0;
  const struct iterate_kit_register_write *writes = iterate_kit_tas2780_base_script(&count);
  assert(count == 20);
  assert(iterate_kit_tas2780_base_script(NULL) == writes);
  uint8_t recorded[20][2];
  for (size_t i = 0; i < count; ++i) {
    recorded[i][0] = writes[i].address;
    recorded[i][1] = writes[i].value;
  }
  assert(memcmp(recorded, expected, sizeof(expected)) == 0);
}

static void iterate_kit_tas2780_test_volume(void) {
  const uint8_t rows[][2] = {{0, 0xC8}, {50, 0x64}, {100, 0}, {101, 0}, {255, 0}};
  for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); ++i) {
    assert(iterate_kit_tas2780_dvc_for_percent(rows[i][0]) == rows[i][1]);
  }
  assert(ITERATE_KIT_TAS2780_DVC_MUTE == 0xC9);
}

static void iterate_kit_tas2780_test_power(void) {
  const uint16_t rows[][3] = {
    {739, 500, ITERATE_KIT_TAS2780_POWER_MODE_0},
    {740, 0, ITERATE_KIT_TAS2780_POWER_MODE_2},
    {741, 500, ITERATE_KIT_TAS2780_POWER_MODE_2},
    {739, 289, ITERATE_KIT_TAS2780_POWER_MODE_NONE},
    {739, 290, ITERATE_KIT_TAS2780_POWER_MODE_NONE},
    {739, 291, ITERATE_KIT_TAS2780_POWER_MODE_0},
    {739, 549, ITERATE_KIT_TAS2780_POWER_MODE_0},
    {739, 550, ITERATE_KIT_TAS2780_POWER_MODE_0},
    {739, 551, ITERATE_KIT_TAS2780_POWER_MODE_NONE},
    {740, 551, ITERATE_KIT_TAS2780_POWER_MODE_2},
    {0, 0, ITERATE_KIT_TAS2780_POWER_MODE_NONE},
    {UINT16_MAX, UINT16_MAX, ITERATE_KIT_TAS2780_POWER_MODE_2},
  };
  for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); ++i) {
    assert(iterate_kit_tas2780_power_mode_for(rows[i][0], rows[i][1]) == rows[i][2]);
  }
  struct iterate_kit_register_write writes[3];
  assert(iterate_kit_tas2780_power_registers(ITERATE_KIT_TAS2780_POWER_MODE_0, 0xFF, 0xFF, writes));
  const struct iterate_kit_register_write mode_0[] = {{0x03, 0x91}, {0x04, 0x7F}, {0x71, 0x03}};
  assert(memcmp(writes, mode_0, sizeof(writes)) == 0);
  assert(!iterate_kit_tas2780_power_registers(ITERATE_KIT_TAS2780_POWER_MODE_NONE, 0, 0, writes));
  assert(memcmp(writes, mode_0, sizeof(writes)) == 0);
  assert(iterate_kit_tas2780_power_registers(ITERATE_KIT_TAS2780_POWER_MODE_2, 0x3E, 0x55, writes));
  const struct iterate_kit_register_write mode_2[] = {{0x03, 0xD0}, {0x04, 0xD5}, {0x71, 0x11}};
  assert(memcmp(writes, mode_2, sizeof(writes)) == 0);
  assert(!iterate_kit_tas2780_power_registers(ITERATE_KIT_TAS2780_POWER_MODE_0, 0, 0, NULL));
}

static void iterate_kit_tas2780_test_sar(void) {
  const uint16_t rows[][5] = {
    /* msb, lsb, raw, VBAT1S centivolts, PVDD centivolts */
    {0, 0, 0, 0, 0}, {0, 0x0F, 0, 0, 0}, {0, 0x1F, 1, 0, 1},
    {0x28, 0, 640, 500, 1000}, {0x1D, 0xAF, 474, 370, 740},
    {0xFF, 0xFF, 4095, 3199, 6398},
  };
  for (size_t i = 0; i < sizeof(rows) / sizeof(rows[0]); ++i) {
    assert(iterate_kit_tas2780_sar_raw((uint8_t)rows[i][0], (uint8_t)rows[i][1]) == rows[i][2]);
    assert(iterate_kit_tas2780_vbat1s_centivolts((uint8_t)rows[i][0], (uint8_t)rows[i][1]) == rows[i][3]);
    assert(iterate_kit_tas2780_pvdd_centivolts((uint8_t)rows[i][0], (uint8_t)rows[i][1]) == rows[i][4]);
  }
}

static void iterate_kit_tas2780_test_faults(void) {
  const uint32_t masks[] = {
    ITERATE_KIT_TAS2780_FAULT_IR_OT, ITERATE_KIT_TAS2780_FAULT_IR_OC,
    ITERATE_KIT_TAS2780_FAULT_IR_TDMCE, ITERATE_KIT_TAS2780_FAULT_IR_LIMA,
    ITERATE_KIT_TAS2780_FAULT_IR_PBIP, ITERATE_KIT_TAS2780_FAULT_IR_LIMMA,
    ITERATE_KIT_TAS2780_FAULT_IR_BOPIH, ITERATE_KIT_TAS2780_FAULT_IR_BOPM,
    ITERATE_KIT_TAS2780_FAULT_IR_VBATLIM, ITERATE_KIT_TAS2780_FAULT_IR_LDMODE,
    ITERATE_KIT_TAS2780_FAULT_IR_LDC, ITERATE_KIT_TAS2780_FAULT_IR_OTPCRC,
    ITERATE_KIT_TAS2780_FAULT_IR_VBAT1S_UVLO, ITERATE_KIT_TAS2780_FAULT_IR_PLL_CLK,
    ITERATE_KIT_TAS2780_FAULT_IR_PUVLO, ITERATE_KIT_TAS2780_FAULT_IR_LDO_OL,
    ITERATE_KIT_TAS2780_FAULT_IR_LDO_OV, ITERATE_KIT_TAS2780_FAULT_IR_LDO_UV,
  };
  const uint8_t registers[][4] = {
    {1,0,0,0}, {2,0,0,0}, {4,0,0,0}, {8,0,0,0},
    {16,0,0,0}, {32,0,0,0}, {64,0,0,0}, {128,0,0,0},
    {0,1,0,0}, {0,24,0,0}, {0,32,0,0}, {0,64,0,0},
    {0,0,32,0}, {0,0,128,0},
    {0,0,0,1}, {0,0,0,2}, {0,0,0,4}, {0,0,0,8},
  };
  assert(sizeof(masks) / sizeof(masks[0]) == sizeof(registers) / sizeof(registers[0]));
  for (size_t i = 0; i < sizeof(masks) / sizeof(masks[0]); ++i) {
    assert(iterate_kit_tas2780_decode_faults(registers[i][0], registers[i][1],
        registers[i][2], registers[i][3]) == masks[i]);
  }
  assert(iterate_kit_tas2780_decode_faults(0xFF, 0xFF, 0xFF, 0xFF) == 0x0FA079FFU);
  assert(iterate_kit_tas2780_decode_faults(0, 0x86, 0x5F, 0xF0) == 0);
}

int main(void) {
  iterate_kit_tas2780_test_script();
  iterate_kit_tas2780_test_volume();
  iterate_kit_tas2780_test_power();
  iterate_kit_tas2780_test_sar();
  iterate_kit_tas2780_test_faults();
  return 0;
}
