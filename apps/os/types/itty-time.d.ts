declare module "itty-time" {
  type DurationUnit = "year" | "month" | "week" | "day" | "hour" | "minute" | "second" | "m";
  type DurationUnitPlural = `${DurationUnit}s`;
  export type DurationString = `${number}` | `${number} ${DurationUnit | DurationUnitPlural}`;

  export const ms: (duration: DurationString | number) => number;
  export const seconds: (duration: DurationString | number) => number;
  export const datePlus: (duration: DurationString | number, from = new Date()) => Date;
}
