#ifndef ITERATE_KIT_TEST_I2S_STD_H
#define ITERATE_KIT_TEST_I2S_STD_H
/* Only the IDF value types used by board.c's pure validation. No fake driver
 * functions: these tests cannot claim a hardware bring-up succeeded. */
#include <stdbool.h>
#include <stdint.h>
/** Host value of an ESP32-S3 GPIO; -1 is unused. */
typedef int gpio_num_t;
/** The two controllers on ESP32-S3. */
typedef enum { I2S_NUM_0, I2S_NUM_1 } i2s_port_t;
/** Which side produces the clocks. */
typedef enum { I2S_ROLE_MASTER, I2S_ROLE_SLAVE } i2s_role_t;
/** Opaque channel, unused by the pure tests. */
typedef void *i2s_chan_handle_t;
enum { SOC_I2S_NUM = 2, GPIO_NUM_MAX = 49, I2S_GPIO_UNUSED = -1,
  I2S_SLOT_BIT_WIDTH_AUTO = 0, I2S_CLK_SRC_EXTERNAL = 1 };
/** IDF standard-mode pin values relevant to clock and data ownership. */
typedef struct {
  gpio_num_t mclk, bclk, ws, dout, din;
  struct { bool mclk_inv, bclk_inv, ws_inv; } invert_flags;
} i2s_std_gpio_config_t;
/** IDF clock/slot values relevant to one PCM shape, plus pins. */
typedef struct {
  struct { uint32_t sample_rate_hz; int mclk_multiple, clk_src; } clk_cfg;
  struct {
    unsigned data_bit_width, slot_bit_width, slot_mode, ws_width;
    bool ws_pol, bit_shift;
  } slot_cfg;
  i2s_std_gpio_config_t gpio_cfg;
} i2s_std_config_t;
#endif
