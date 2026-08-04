idf_component_register(
  SRCS "stackchan_avatar.c"
  INCLUDE_DIRS "include"
  REQUIRES
    avatar
    capabilities
    core
    espressif__esp_lcd_touch
    espressif__m5stack_core_s3
    esp_lcd
    esp_rom
    esp_timer
    freertos
    heap
)
target_compile_features(${COMPONENT_LIB} PUBLIC c_std_99)
target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall
  -Wextra
  -Werror
  # ESP-IDF's public LCD and I2C headers deliberately use zero-member structs.
  # Keep every useful warning fatal at this SDK boundary without pretending
  # those upstream GCC extensions are defects in the avatar implementation.
  -Wno-pedantic
)
