import type {
  KitAecMetrics,
  KitAvatarMetrics,
  KitDevice,
  KitDeviceDescription,
  KitMetrics,
} from "./kit-device-contract.ts";

export type StackChanMetrics = KitMetrics;
export type StackChanDescription = KitDeviceDescription;

export interface StackChan extends KitDevice {
  captureScreen(): Promise<Uint8Array>;
  subscribeToAecMetrics(callback: (metrics: KitAecMetrics) => void): Promise<void>;
  subscribeToAvatarMetrics(callback: (metrics: KitAvatarMetrics) => void): Promise<void>;
  servos: {
    move(input: { yawDegrees: number; pitchDegrees: number; speed: number }): Promise<boolean>;
  };
  leds: {
    set(input: { index: number; red: number; green: number; blue: number }): Promise<boolean>;
    fill(input: { red: number; green: number; blue: number }): Promise<boolean>;
  };
  takePhoto(): Promise<Uint8Array>;
}
