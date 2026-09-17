# The host ESP-IDF (esp_idf/esp_idf.h): the primitives the shared voice loop
# names, on a laptop. Linked by the voice loop tests (with a pinned clock) and
# by targets/mac (with the real one). Portable C: no Apple API in here.
add_library(iterate-kit-host-esp-idf STATIC esp_idf/esp_idf.c)
target_include_directories(iterate-kit-host-esp-idf PUBLIC esp_idf)
target_compile_features(iterate-kit-host-esp-idf PUBLIC c_std_11)
target_compile_options(iterate-kit-host-esp-idf PRIVATE -Wall -Wextra -Werror)
