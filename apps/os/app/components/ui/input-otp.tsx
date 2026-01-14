import * as React from "react";
import { cn } from "@/lib/utils.ts";

interface InputOTPProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
  id?: string;
}

/**
 * OTP input using a single hidden input for reliable automation/autofill support.
 * Visual boxes are purely presentational - all typing goes to the hidden input.
 *
 * Browser automation friendly:
 * - Single input with semantic name/autocomplete attributes
 * - Supports paste of formatted codes (e.g., "123-456" -> "123456")
 * - Uses transparent text instead of opacity-0 for better accessibility
 */
export function InputOTP({
  length = 6,
  value,
  onChange,
  disabled,
  className,
  autoFocus,
  id = "otp-input",
}: InputOTPProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState(false);

  const processValue = React.useCallback(
    (rawValue: string) => {
      const digits = rawValue.replace(/\D/g, "").slice(0, length);
      onChange(digits);
    },
    [length, onChange],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    processValue(e.target.value);
  };

  // Listen for native input events for browser automation compatibility
  // Browser automation tools (Playwright, Puppeteer) often dispatch native events
  // that bypass React's synthetic event system
  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const handleNativeInput = (e: Event) => {
      const target = e.target as HTMLInputElement;
      processValue(target.value);
    };

    input.addEventListener("input", handleNativeInput);
    return () => input.removeEventListener("input", handleNativeInput);
  }, [processValue]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  // Handle paste of formatted codes like "123-456" or "123 456"
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text");
    // Strip all non-digits and limit to length
    const digits = pasted.replace(/\D/g, "").slice(0, length);
    onChange(digits);
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
        id={id}
        name="one-time-code"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={length}
        autoComplete="one-time-code"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        autoFocus={autoFocus}
        // Use transparent text/caret instead of opacity-0 for better accessibility
        // and compatibility with browser automation tools
        className="absolute inset-0 w-full h-full cursor-pointer bg-transparent border-0 outline-none text-transparent caret-transparent selection:bg-transparent"
        aria-label={`Enter ${length}-digit code`}
        data-testid="otp-input"
        data-input-otp="true"
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
