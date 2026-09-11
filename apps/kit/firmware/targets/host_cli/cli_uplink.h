#ifndef ITERATE_KIT_CLI_UPLINK_H
#define ITERATE_KIT_CLI_UPLINK_H
#include <stdint.h>
struct cli_runtime;
void cli_uplink_step(struct cli_runtime *runtime, uint64_t now_ms);
void cli_uplink_reset(struct cli_runtime *runtime);
#endif
