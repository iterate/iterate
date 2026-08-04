/*
 * Host harnesses and the deployed userspace app must decode the exact same
 * release receipt. The implementation belongs to the deployable app's source
 * mask; this compatibility export keeps existing host imports stable without
 * copying protocol logic into a second module.
 */
export * from "../userspace/config-worker/device-pcm-wire.ts";
