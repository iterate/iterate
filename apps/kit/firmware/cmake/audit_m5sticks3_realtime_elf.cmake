cmake_minimum_required(VERSION 3.16)

# This audit intentionally consumes the linked ELF rather than trusting source
# attributes. IRAM_ATTR on the callback is insufficient when one indirect
# backend thunk, atomic helper, timer read, or task notification migrates back
# to flash after a toolchain/configuration change.
if(NOT DEFINED CONFIG_FILE OR NOT EXISTS "${CONFIG_FILE}")
  message(FATAL_ERROR "Realtime ELF audit requires CONFIG_FILE")
endif()
file(READ "${CONFIG_FILE}" ITERATE_KIT_CONFIG)
foreach(REQUIRED_CONFIG
    "CONFIG_I2S_ISR_IRAM_SAFE=y"
    "CONFIG_STDATOMIC_S32C1I_SPIRAM_WORKAROUND=y")
  string(FIND "${ITERATE_KIT_CONFIG}" "${REQUIRED_CONFIG}" CONFIG_INDEX)
  if(CONFIG_INDEX EQUAL -1)
    message(FATAL_ERROR
      "Realtime ELF audit requires ${REQUIRED_CONFIG}")
  endif()
endforeach()

# SYMBOL_TABLE_FILE makes the same production audit executable against tiny
# host fixtures. The target path always invokes the real cross-objdump itself,
# so a stale checked-in map can never satisfy a firmware build.
if(DEFINED SYMBOL_TABLE_FILE)
  if(NOT EXISTS "${SYMBOL_TABLE_FILE}")
    message(FATAL_ERROR
      "Realtime ELF audit fixture does not exist: ${SYMBOL_TABLE_FILE}")
  endif()
  file(READ "${SYMBOL_TABLE_FILE}" ITERATE_KIT_SYMBOL_TABLE)
else()
  if(NOT DEFINED OBJDUMP OR NOT EXISTS "${OBJDUMP}")
    message(FATAL_ERROR "Realtime ELF audit requires OBJDUMP")
  endif()
  if(NOT DEFINED ELF OR NOT EXISTS "${ELF}")
    message(FATAL_ERROR "Realtime ELF audit requires a linked ELF")
  endif()
  execute_process(
    COMMAND "${OBJDUMP}" -t -C "${ELF}"
    RESULT_VARIABLE OBJDUMP_STATUS
    OUTPUT_VARIABLE ITERATE_KIT_SYMBOL_TABLE
    ERROR_VARIABLE OBJDUMP_ERROR
  )
  if(NOT OBJDUMP_STATUS EQUAL 0)
    message(FATAL_ERROR
      "Cross-objdump failed (${OBJDUMP_STATUS}): ${OBJDUMP_ERROR}")
  endif()
endif()

function(require_symbol_in_section SYMBOL_NAME REQUIRED_SECTION)
  string(REPLACE "\n" ";" SYMBOL_LINES "${ITERATE_KIT_SYMBOL_TABLE}")
  set(SYMBOL_FOUND FALSE)
  foreach(SYMBOL_LINE IN LISTS SYMBOL_LINES)
    string(FIND "${SYMBOL_LINE}" "${SYMBOL_NAME}" SYMBOL_INDEX)
    if(NOT SYMBOL_INDEX EQUAL -1)
      set(SYMBOL_FOUND TRUE)
      # Match a complete objdump section token. A substring check would accept
      # `.ext_ram.bss` as `.bss`, defeating the precise property this audit
      # exists to prove.
      string(REPLACE "\t" " " NORMALIZED_SYMBOL_LINE "${SYMBOL_LINE}")
      set(PADDED_SYMBOL_LINE " ${NORMALIZED_SYMBOL_LINE} ")
      string(FIND
        "${PADDED_SYMBOL_LINE}" " ${REQUIRED_SECTION} " SECTION_INDEX)
      if(SECTION_INDEX EQUAL -1)
        message(FATAL_ERROR
          "Realtime symbol '${SYMBOL_NAME}' is not in "
          "${REQUIRED_SECTION}: ${SYMBOL_LINE}")
      endif()
    endif()
  endforeach()
  if(NOT SYMBOL_FOUND)
    message(FATAL_ERROR
      "Realtime ELF audit could not find '${SYMBOL_NAME}'")
  endif()
endfunction()

foreach(IRAM_SYMBOL
    "M5StickS3DirectI2sOps::onSent("
    "M5StickS3DirectI2sOps::onSendQueueOverflow("
    "M5StickS3DirectI2sOps::notifyOwnerFromIsr("
    "::sentThunk("
    "::overflowThunk("
    "::incrementOverflow("
    "esp_timer_get_time"
    "vTaskGenericNotifyGiveFromISR"
    "__atomic_compare_exchange_4"
    "__atomic_fetch_add_4")
  require_symbol_in_section("${IRAM_SYMBOL}" ".iram0.text")
endforeach()

# The callback context and every atomic it touches live inside the one static
# runtime object. Require ESP-IDF's explicit internal `.dram0.bss` output
# section; accepting generic `.bss` or `.ext_ram.bss` would make cache-backed
# PSRAM indistinguishable from memory an ISR can safely reach.
require_symbol_in_section(
  "(anonymous namespace)::runtime" ".dram0.bss")

message(STATUS
  "M5StickS3 realtime ELF audit passed: ISR graph in IRAM, context in DIRAM")
