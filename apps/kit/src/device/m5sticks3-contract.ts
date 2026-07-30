import type {
  KitDevice,
  KitDeviceDescription,
  KitAudioMetrics,
  KitMetrics,
  KitPlaybackMetrics,
} from "./kit-device-contract.ts";

export type M5StickS3Metrics = KitMetrics & {
  audio: KitAudioMetrics;
};
export type M5StickS3Description = KitDeviceDescription;

export interface M5StickS3 extends KitDevice {
  subscribeToPlaybackMetrics(callback: (metrics: KitPlaybackMetrics) => void): Promise<void>;
  pushToTalk: {
    start(): Promise<boolean>;
    stop(): Promise<boolean>;
  };
}
