import type {
  KitDevice,
  KitDeviceDescription,
  KitAudioMetrics,
  KitControlDiagnostics,
  KitMetrics,
  KitPlaybackMetrics,
} from "./kit-device-contract.ts";

export type M5StickS3Metrics = KitMetrics & {
  audio: KitAudioMetrics;
};
export type M5StickS3Description = KitDeviceDescription;

export interface M5StickS3 extends KitDevice {
  getDiagnostics(): Promise<KitControlDiagnostics>;
  subscribeToPlaybackMetrics(callback: (metrics: KitPlaybackMetrics) => void): Promise<void>;
  pushToTalk: {
    start(): Promise<boolean>;
    stop(): Promise<boolean>;
  };
}
