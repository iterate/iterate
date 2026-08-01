cmake_minimum_required(VERSION 3.16)

# Source annotations are intentions; this audit checks the linked program which
# will actually run while SPI flash cache is disabled. One accidental flash
# helper in the DMA callback would turn unrelated flash activity into an audio
# timing fault, exactly the kind of intermittent jiggle this design forbids.
if(NOT DEFINED CONFIG_FILE OR NOT EXISTS "${CONFIG_FILE}")
  message(FATAL_ERROR "CoreS3 realtime ELF audit requires CONFIG_FILE")
endif()
file(READ "${CONFIG_FILE}" ITERATE_KIT_CONFIG)
foreach(REQUIRED_CONFIG
    "CONFIG_I2S_ISR_IRAM_SAFE=y"
    "CONFIG_STDATOMIC_S32C1I_SPIRAM_WORKAROUND=y")
  string(FIND "${ITERATE_KIT_CONFIG}" "${REQUIRED_CONFIG}" CONFIG_INDEX)
  if(CONFIG_INDEX EQUAL -1)
    message(FATAL_ERROR
      "CoreS3 realtime ELF audit requires ${REQUIRED_CONFIG}")
  endif()
endforeach()

if(NOT DEFINED OBJDUMP OR NOT EXISTS "${OBJDUMP}")
  message(FATAL_ERROR "CoreS3 realtime ELF audit requires OBJDUMP")
endif()
if(NOT DEFINED ELF OR NOT EXISTS "${ELF}")
  message(FATAL_ERROR "CoreS3 realtime ELF audit requires a linked ELF")
endif()
execute_process(
  COMMAND "${OBJDUMP}" -t -C "${ELF}"
  RESULT_VARIABLE OBJDUMP_STATUS
  OUTPUT_VARIABLE SYMBOL_TABLE
  ERROR_VARIABLE OBJDUMP_ERROR
)
if(NOT OBJDUMP_STATUS EQUAL 0)
  message(FATAL_ERROR
    "Cross-objdump failed (${OBJDUMP_STATUS}): ${OBJDUMP_ERROR}")
endif()

function(require_symbol_in_section SYMBOL_NAME REQUIRED_SECTION)
  string(REPLACE "\n" ";" SYMBOL_LINES "${SYMBOL_TABLE}")
  set(SYMBOL_FOUND FALSE)
  foreach(SYMBOL_LINE IN LISTS SYMBOL_LINES)
    string(REGEX MATCH "[^ \t]+$" LINE_SYMBOL "${SYMBOL_LINE}")
    if(LINE_SYMBOL STREQUAL SYMBOL_NAME)
      set(SYMBOL_FOUND TRUE)
      string(REPLACE "\t" " " NORMALIZED "${SYMBOL_LINE}")
      set(PADDED " ${NORMALIZED} ")
      string(FIND "${PADDED}" " ${REQUIRED_SECTION} " SECTION_INDEX)
      if(SECTION_INDEX EQUAL -1)
        message(FATAL_ERROR
          "CoreS3 realtime symbol '${SYMBOL_NAME}' is not in "
          "${REQUIRED_SECTION}: ${SYMBOL_LINE}")
      endif()
    endif()
  endforeach()
  if(NOT SYMBOL_FOUND)
    message(FATAL_ERROR
      "CoreS3 realtime ELF audit could not find '${SYMBOL_NAME}'")
  endif()
endfunction()

# The complete callback graph consists of the BSP descriptor callback, the
# Iterate raw-copy handoff, ESP's timer/task wake and one ROM memcpy. Helper
# policy functions in capture_reserve are inlined into push_raw at -O3; naming
# the outer linked symbol makes any later out-of-line migration fail here.
foreach(IRAM_SYMBOL
    "on_i2s_rx_received"
    "on_i2s_rx_queue_overflow"
    "on_i2s_tx_sent"
    "on_i2s_tx_queue_overflow"
    "i2s_tap"
    "iterate_kit_core_s3_capture_reserve_push_raw"
    "esp_timer_get_time"
    "vTaskGenericNotifyGiveFromISR"
    "__atomic_fetch_add_4")
  require_symbol_in_section("${IRAM_SYMBOL}" ".iram0.text")
endforeach()
require_symbol_in_section("memcpy" "*ABS*")

# Every byte dereferenced by the ISR must remain in internal DRAM. Accepting a
# generic .bss match would also accept cache-backed external RAM and nullify
# the IRAM call-graph guarantee.
require_symbol_in_section("owner" ".dram0.data")
foreach(DRAM_SYMBOL
    "i2s_rx_dma_events"
    "i2s_rx_dma_sequence"
    "i2s_tx_dma_events"
    "i2s_tx_dma_sequence")
  require_symbol_in_section("${DRAM_SYMBOL}" ".dram0.data")
endforeach()
foreach(DRAM_SYMBOL
    "i2s_tap_callback"
    "i2s_tap_user_data")
  require_symbol_in_section("${DRAM_SYMBOL}" ".dram0.bss")
endforeach()

message(STATUS
  "CoreS3 realtime ELF audit passed: callback graph in IRAM/ROM, state in DRAM")
