import type {
  KitDevice,
  KitDeviceDescription,
  KitAudioMetrics,
  KitMetrics,
} from "./kit-device-contract.ts";

export type M5StickS3Metrics = KitMetrics & {
  audio: KitAudioMetrics;
};
export type M5StickS3Description = KitDeviceDescription;

export interface M5StickS3 extends KitDevice {
  pushToTalk: {
    start(): Promise<boolean>;
    stop(): Promise<boolean>;
  };
}
