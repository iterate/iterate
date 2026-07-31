# ESP-IDF discovers managed components after EXTRA_COMPONENT_DIRS, so the
# managed CoreS3 BSP legitimately supersedes the shared Iterate override during
# the first discovery pass.  Project components are discovered last and are
# the documented highest-priority seam.  This tiny target-local wrapper gives
# the shared override that priority while keeping the actual audited patch in
# one place for every future CoreS3 target.
#
# When ESP-IDF selects this component, COMPONENT_OVERRIDEN_DIR points at the
# pinned managed BSP.  The shared definition intentionally consumes that
# property, verifies the exact BSP version/source, and generates patched build
# inputs without modifying the component-manager checkout.
include(
  "${CMAKE_CURRENT_LIST_DIR}/../../../../platforms/iterate_esp_idf/idf_overrides/espressif__m5stack_core_s3/CMakeLists.txt"
)
