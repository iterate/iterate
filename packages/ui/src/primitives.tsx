import type { ComponentProps, ReactNode } from "react";
import { Button as ShadButton } from "./components/button.tsx";
import { Input as ShadInput } from "./components/input.tsx";
import { Label } from "./components/label.tsx";
import { Textarea as ShadTextarea } from "./components/textarea.tsx";
import { cn } from "./lib/utils.ts";

type LegacyButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ShadButtonVariant = NonNullable<ComponentProps<typeof ShadButton>["variant"]>;
type ButtonVariant = LegacyButtonVariant | ShadButtonVariant;

const variantMap: Record<LegacyButtonVariant, "default" | "secondary" | "destructive" | "ghost"> = {
  primary: "default",
  secondary: "secondary",
  danger: "destructive",
  ghost: "ghost",
};

export function Button(
  props: Omit<ComponentProps<typeof ShadButton>, "variant"> & {
    variant?: ButtonVariant;
  },
) {
  const { variant, ...rest } = props;
  if (variant === undefined) {
    return <ShadButton {...rest} />;
  }

  const mappedVariant =
    variant in variantMap
      ? variantMap[variant as LegacyButtonVariant]
      : (variant as ShadButtonVariant);

  return <ShadButton {...rest} variant={mappedVariant} />;
}

export function Input(props: ComponentProps<typeof ShadInput>) {
  return <ShadInput {...props} />;
}

export function Textarea(props: ComponentProps<typeof ShadTextarea>) {
  return <ShadTextarea {...props} />;
}

export function Field(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("grid gap-2", props.className)}>
      <Label className="text-muted-foreground">{props.label}</Label>
      {props.children}
    </label>
  );
}
