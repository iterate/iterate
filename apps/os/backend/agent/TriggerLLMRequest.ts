import { z } from "zod/v4";

export const TriggerLLMRequest = z.custom<`${"true" | "false"}:${string}`>((val) => {
  return typeof val === "string" && (val.startsWith("true:") || val.startsWith("false:"));
});
export type TriggerLLMRequest = z.infer<typeof TriggerLLMRequest>;

export const triggerLLMRequest = {
  and: (...defined: TriggerLLMRequest[]): TriggerLLMRequest => {
    if (defined.every((arg) => arg?.startsWith("true:"))) {
      return `true:AND(${defined.join(";")})`;
    }
    return `false:AND(${defined.join(";")})`;
  },
  or: (...args: TriggerLLMRequest[]): TriggerLLMRequest => {
    if (args.some((arg) => arg?.startsWith("true:"))) {
      return `true:OR(${args.join(";")})`;
    }
    return `false:OR(${args.join(";")})`;
  },
};
