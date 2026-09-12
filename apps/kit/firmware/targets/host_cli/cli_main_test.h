#ifndef ITERATE_KIT_CLI_MAIN_TEST_H
#define ITERATE_KIT_CLI_MAIN_TEST_H

#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/voicelab_stream.h"

struct cli_runtime;

void iterate_kit_cli_main_test_poll_hangup(
    struct cli_runtime *runtime, uint64_t now_ms);
void iterate_kit_cli_main_test_reconcile_call(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free);
void iterate_kit_cli_main_test_on_control(
    struct cli_runtime *runtime, enum iterate_kit_voicelab_control control);

#endif
