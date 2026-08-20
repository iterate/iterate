#ifndef ITERATE_KIT_DEVICES_HAVPE_H
#define ITERATE_KIT_DEVICES_HAVPE_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Run the Home Assistant Voice Preview Edition voice device: provision,
 * bring up the XMOS/AIC3204 audio path (failing closed on an unverified
 * DSP), mount itx.kit.homeAssistantVoicePreviewEdition over one Cap'n Web
 * /api socket, and serve the open-mic conversation loop forever.
 */
void iterate_kit_havpe_run(void);

#ifdef __cplusplus
}
#endif

#endif
