import type {
  KitAecMetrics,
  KitDevice,
  KitDeviceDescription,
  KitMetrics,
} from "./kit-device-contract.ts";

export type StackChanMetrics = KitMetrics;
export type StackChanDescription = KitDeviceDescription;

export interface StackChan extends KitDevice {
  subscribeToAecMetrics(callback: (metrics: KitAecMetrics) => void): Promise<void>;
  servos: {
    move(input: { yawDegrees: number; pitchDegrees: number; speed: number }): Promise<boolean>;
  };
  leds: {
    set(input: { index: number; red: number; green: number; blue: number }): Promise<boolean>;
    fill(input: { red: number; green: number; blue: number }): Promise<boolean>;
  };
  takePhoto(): Promise<Uint8Array>;
}
