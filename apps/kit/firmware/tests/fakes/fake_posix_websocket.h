#ifndef ITERATE_KIT_TESTS_FAKE_POSIX_WEBSOCKET_H
#define ITERATE_KIT_TESTS_FAKE_POSIX_WEBSOCKET_H

#include "iterate/kit/platforms/posix_websocket_client.h"

void iterate_kit_fake_posix_websocket_queue_peer_close(void);
void iterate_kit_fake_posix_websocket_set_open_result(
    enum iterate_kit_posix_websocket_open_result result);

#endif
