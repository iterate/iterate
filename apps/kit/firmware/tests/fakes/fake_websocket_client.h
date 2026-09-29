#ifndef ITERATE_KIT_TESTS_FAKE_WEBSOCKET_CLIENT_H
#define ITERATE_KIT_TESTS_FAKE_WEBSOCKET_CLIENT_H

#include "iterate/kit/websocket_client.h"

/*
 * The WebSocket client as a transport test scripts it: linked in place of
 * components/core's, so the transport's generations, deadlines and retry
 * gate run while the socket does only what the test says.
 */
void iterate_kit_fake_websocket_client_queue_peer_close(void);
void iterate_kit_fake_websocket_client_set_open_result(
    enum iterate_kit_websocket_open_result result);
/* The next opens get this answer: 101 upgrades, any other status fails. */
void iterate_kit_fake_websocket_client_answer_upgrade(int32_t status);

#endif
