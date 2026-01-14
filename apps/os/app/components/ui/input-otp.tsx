import * as React from "react";
import { cn } from "@/lib/utils.ts";

interface InputOTPProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
}

/**
 * OTP input using a single hidden input for reliable automation/autofill support.
 * Visual boxes are purely presentational - all typing goes to the hidden input.
 */
export function InputOTP({
  length = 6,
  value,
  onChange,
  disabled,
  className,
  autoFocus,
}: InputOTPProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, length);
    onChange(digits);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  const focusInput = () => {
    inputRef.current?.focus();
  };

  const activeIndex = Math.min(value.length, length - 1);

  return (
    <div
      className={cn("relative flex gap-2 justify-center", className)}
      onClick={focusInput}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        autoFocus={autoFocus}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        aria-label={`Enter ${length}-digit code`}
        data-testid="otp-input"
      />

      {Array.from({ length }).map((_, index) => (
        <div
          key={index}
          className={cn(
            "h-12 w-10 rounded-md border bg-transparent text-center text-lg font-semibold shadow-sm transition-colors flex items-center justify-center",
            focused && index === activeIndex
              ? "ring-2 ring-ring border-transparent"
              : "border-input",
            disabled && "cursor-not-allowed opacity-50",
          )}
          aria-hidden="true"
        >
          {value[index] || ""}
        </div>
      ))}
    </div>
  );
}
