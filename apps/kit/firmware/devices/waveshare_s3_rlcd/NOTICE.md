ST7305 register initialization and landscape pixel packing in rlcd_display.c
are adapted from Waveshare ESP32-S3-RLCD-4.2, 07_Audio_Test/display_bsp.cpp.
Source: https://github.com/waveshareteam/ESP32-S3-RLCD-4.2
Licensed under Apache License 2.0; see LICENSE.waveshare.md.
The Iterate implementation uses synchronous SPI, a small status font, and
checked initialization instead of the vendor C++/LVGL display class.
