#ifndef ITERATE_KIT_CLI_CAPABILITIES_H
#define ITERATE_KIT_CLI_CAPABILITIES_H

/*
 * cli_capabilities: remote controls and device-compatible health JSON.
 *
 * Health is a wire contract, not prose. Its key spelling and order match the
 * physical target because the node-side endurance harness reads the object
 * directly. Formatting is bounded and reports overflow rather than returning
 * truncated JSON that would make a sick target look absent.
 */

#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/peer.h"

enum {
  CLI_CAPABILITIES_HEALTH_BYTES = 1536,
};

enum cli_capabilities_status {
  CLI_CAPABILITIES_OK = 0,
  CLI_CAPABILITIES_ERR_ARG,
  CLI_CAPABILITIES_ERR_OVERFLOW,
  CLI_CAPABILITIES_ERR_APPEND,
};

struct cli_runtime;

/** Module callback context; the peer borrows it for the runtime lifetime. */
struct cli_capabilities {
  struct cli_runtime *runtime;
  char health[CLI_CAPABILITIES_HEALTH_BYTES];
};

/** Human-readable status name for top-level diagnostics. */
const char *cli_capabilities_status_name(enum cli_capabilities_status status);

/** Bind the target runtime and return its capability module. */
struct iterate_kit_module cli_capabilities_module(
    struct cli_capabilities *capabilities, struct cli_runtime *runtime);

/** Borrow the capability description expression for peer initialization. */
const char *cli_capabilities_description(size_t *out_length);

/** Write the byte-stable health object, returning zero on overflow. */
size_t cli_capabilities_health_json(
    struct cli_runtime *runtime, char *out, size_t capacity);

/** Append one ephemeral development-stats event to the voicelab outbox. */
enum cli_capabilities_status cli_capabilities_append_stats(
    struct cli_runtime *runtime);

/** Arm a bounded process re-exec after the capability reply can leave. */
void cli_capabilities_request_restart(
    struct cli_runtime *runtime, uint64_t now_ms);

/** Connection callback that invalidates all session-scoped voicelab handles. */
void cli_capabilities_session_ended(void *context);

#endif /* ITERATE_KIT_CLI_CAPABILITIES_H */
