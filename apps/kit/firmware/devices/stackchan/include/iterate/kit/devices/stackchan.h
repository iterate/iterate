#ifndef ITERATE_KIT_DEVICES_STACKCHAN_H
#define ITERATE_KIT_DEVICES_STACKCHAN_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Run the StackChan voice robot: provision, bring up the face, body, and
 * the tuned CoreS3 AEC audio path, mount itx.kit.stackchan over one Cap'n
 * Web /api socket, and serve the full-duplex conversation loop forever.
 */
void iterate_kit_stackchan_run(void);

#ifdef __cplusplus
}
#endif

#endif
