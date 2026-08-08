#ifndef ITERATE_KIT_DEVICES_M5STICKS3_H
#define ITERATE_KIT_DEVICES_M5STICKS3_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Run the M5StickS3 voice device: provision, bring up the board and the
 * half-duplex ES8311 audio path, mount itx.kit.m5sticks3 over one Cap'n Web
 * /api socket, and serve the push-to-talk conversation loop forever.
 */
void iterate_kit_m5sticks3_run(void);

#ifdef __cplusplus
}
#endif

#endif
