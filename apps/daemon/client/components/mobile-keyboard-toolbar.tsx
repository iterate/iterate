import { useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils.ts";

interface MobileKeyboardToolbarProps {
  onKeyPress: (key: string) => void;
}

// Common terminal keys that are hard to type on mobile keyboards
const PRIMARY_KEYS = [
  { label: "Tab", key: "\t" },
  { label: "Esc", key: "\x1b" },
  { label: "Ctrl", modifier: true },
  { label: "Up", key: "\x1b[A" },
  { label: "Down", key: "\x1b[B" },
  { label: "Left", key: "\x1b[D" },
  { label: "Right", key: "\x1b[C" },
] as const;

// Extended keys in the dropdown menu
const EXTENDED_KEYS = [
  { label: "Ctrl+C", key: "\x03" },
  { label: "Ctrl+D", key: "\x04" },
  { label: "Ctrl+Z", key: "\x1a" },
  { label: "Ctrl+L", key: "\x0c" },
  { label: "Ctrl+R", key: "\x12" },
  { label: "Ctrl+A", key: "\x01" },
  { label: "Ctrl+E", key: "\x05" },
  { label: "Ctrl+U", key: "\x15" },
  { label: "Ctrl+K", key: "\x0b" },
  { label: "Ctrl+W", key: "\x17" },
  { label: "Home", key: "\x1b[H" },
  { label: "End", key: "\x1b[F" },
  { label: "PgUp", key: "\x1b[5~" },
  { label: "PgDn", key: "\x1b[6~" },
  { label: "Del", key: "\x1b[3~" },
  { label: "Ins", key: "\x1b[2~" },
] as const;

export function MobileKeyboardToolbar({ onKeyPress }: MobileKeyboardToolbarProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [ctrlActive, setCtrlActive] = useState(false);

  const handleKeyPress = (
    keyDef: (typeof PRIMARY_KEYS)[number] | (typeof EXTENDED_KEYS)[number],
  ) => {
    if ("modifier" in keyDef && keyDef.modifier) {
      setCtrlActive(!ctrlActive);
      return;
    }

    if (ctrlActive && keyDef.label.length === 1) {
      // Convert letter to ctrl code
      const code = keyDef.label.toUpperCase().charCodeAt(0) - 64;
      onKeyPress(String.fromCharCode(code));
      setCtrlActive(false);
    } else if ("key" in keyDef) {
      onKeyPress(keyDef.key);
    }

    if (!("modifier" in keyDef)) {
      setCtrlActive(false);
    }
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 bg-zinc-900 border-t border-zinc-700 safe-area-inset-bottom">
      {/* Extended keys panel - slides up when expanded */}
      <div
        className={cn(
          "grid grid-cols-4 gap-1 p-2 border-b border-zinc-700 transition-all duration-200",
          isExpanded ? "max-h-48 opacity-100" : "max-h-0 opacity-0 overflow-hidden p-0 border-0",
        )}
      >
        {EXTENDED_KEYS.map((keyDef) => (
          <button
            key={keyDef.label}
            type="button"
            onClick={() => handleKeyPress(keyDef)}
            className="h-9 rounded bg-zinc-800 text-zinc-200 text-xs font-mono active:bg-zinc-600 transition-colors"
          >
            {keyDef.label}
          </button>
        ))}
      </div>

      {/* Primary toolbar */}
      <div className="flex items-center gap-1 p-2">
        {/* Toggle button for extended keys */}
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className={cn(
            "h-9 w-9 flex items-center justify-center rounded transition-colors",
            isExpanded ? "bg-zinc-600 text-white" : "bg-zinc-800 text-zinc-400",
          )}
          aria-label={isExpanded ? "Hide extra keys" : "Show extra keys"}
        >
          {isExpanded ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </button>

        {/* Primary keys */}
        <div className="flex-1 flex items-center gap-1 overflow-x-auto">
          {PRIMARY_KEYS.map((keyDef) => (
            <button
              key={keyDef.label}
              type="button"
              onClick={() => handleKeyPress(keyDef)}
              className={cn(
                "h-9 px-3 rounded text-xs font-mono transition-colors flex-shrink-0",
                "modifier" in keyDef && keyDef.modifier && ctrlActive
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-800 text-zinc-200 active:bg-zinc-600",
              )}
            >
              {keyDef.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
