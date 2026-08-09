#ifndef ITERATE_KIT_FAKE_ESP_IDF_PLATFORM_H
#define ITERATE_KIT_FAKE_ESP_IDF_PLATFORM_H

/*
 * The four platform modules the shared voice loop calls, stood in for on a
 * host: provisioning, reset reason, restart note, and the itx transport.
 *
 * These implement the REAL headers, so every struct the loop sees has its real
 * layout and every call it makes has its real signature. Only the behaviour is
 * pretend — which is the point, because these four are where the loop stops
 * being portable C and starts being a board on a network.
 *
 * See README.md in this directory.
 */

#include "iterate/kit/itx_connection.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Every fixture calls this first; all of it is file-static. */
void iterate_kit_fake_platform_reset(void);

/**
 * THE CONNECTION THE LOOP HANDED ITS TRANSPORT, WHICH IS THE WAY IN.
 *
 * `prepare()` receives it, exactly as the real transport does, and a test uses
 * it to deliver Cap'n Web text — which is what a remote press physically IS.
 * No accessor had to be added to the loop for this: the transport is already
 * the thing that owns the socket's end of the session, so a fake transport is
 * already the thing that owns a pretend socket's end of it.
 *
 * NULL before `iterate_kit_voice_loop_init` has run.
 */
struct iterate_kit_itx_connection *iterate_kit_fake_platform_connection(void);

/**
 * Bring the pretend socket up: open the Cap'n Web session the way the real
 * transport does when TCP connects, and publish READY.
 *
 * Called by a test rather than by a timer, because a transport that connects
 * on its own would make every test race the thing it is testing.
 */
void iterate_kit_fake_platform_connect(void);

/** What the loop reads as the transport's lifecycle state. */
void iterate_kit_fake_platform_set_state(
    enum iterate_kit_esp_idf_itx_transport_state state);

/**
 * Everything the loop sent, in order, as whole Cap'n Web messages.
 *
 * The loop's egress is `send_text` fragments; this reassembles them, because a
 * test asserting on what the device SAID should not have to reassemble a
 * message the transport would have reassembled anyway.
 */
size_t iterate_kit_fake_platform_sent_count(void);
const char *iterate_kit_fake_platform_sent(size_t index);
/** The first sent message containing `needle`, or NULL. */
const char *iterate_kit_fake_platform_find_sent(const char *needle);

/** Probes and restarts the loop asked the transport for. */
size_t iterate_kit_fake_platform_probes_requested(void);
size_t iterate_kit_fake_platform_restarts_requested(void);

/**
 * Answer the next PONG, or stop answering them.
 *
 * The press probe's whole question is whether `websocket_pongs_received` moves.
 * A fake hop that always answered could not fail, and one that never answered
 * could not succeed, so the test says which hop it is testing.
 */
void iterate_kit_fake_platform_set_hop_answers(bool answers);

#ifdef __cplusplus
}
#endif

#endif
