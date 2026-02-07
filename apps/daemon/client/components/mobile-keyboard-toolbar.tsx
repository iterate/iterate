import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils.ts";

interface MobileKeyboardToolbarProps {
  onKeyPress: (key: string) => void;
  ctrlActive?: boolean;
  altActive?: boolean;
  onCtrlToggle?: () => void;
  onAltToggle?: () => void;
}

interface KeyDef {
  label: string;
  key?: string;
  modifier?: "ctrl" | "alt";
  action?: "snippets";
  longPress?: { label: string; key: string };
  /** Render at fixed narrow width (icons, symbols, arrows) */
  icon?: boolean;
}

const TOOLBAR_KEYS: KeyDef[] = [
  { label: "≡", action: "snippets", icon: true },
  { label: "Tab", key: "\t", longPress: { label: "~", key: "~" } },
  { label: "Esc", key: "\x1b", longPress: { label: "`", key: "`" } },
  { label: "Ctrl", modifier: "ctrl" },
  { label: "Alt", modifier: "alt" },
  { label: "-", key: "-", icon: true, longPress: { label: "|", key: "|" } },
  { label: "↑", key: "\x1b[A", icon: true, longPress: { label: "PgUp", key: "\x1b[5~" } },
  { label: "↓", key: "\x1b[B", icon: true, longPress: { label: "PgDn", key: "\x1b[6~" } },
  { label: "←", key: "\x1b[D", icon: true, longPress: { label: "Home", key: "\x1b[H" } },
  { label: "→", key: "\x1b[C", icon: true, longPress: { label: "End", key: "\x1b[F" } },
];

// ── Snippet rows (horizontal scroll) ────────────────────────────────

interface SnippetItem {
  label: string;
  key: string;
}

interface SnippetRow {
  title: string;
  items: SnippetItem[];
}

const SNIPPET_ROWS: SnippetRow[] = [
  {
    title: "Ctrl",
    items: [
      { label: "C", key: "\x03" },
      { label: "D", key: "\x04" },
      { label: "Z", key: "\x1a" },
      { label: "L", key: "\x0c" },
      { label: "R", key: "\x12" },
      { label: "W", key: "\x17" },
      { label: "A", key: "\x01" },
      { label: "E", key: "\x05" },
      { label: "U", key: "\x15" },
      { label: "K", key: "\x0b" },
      { label: "P", key: "\x10" },
      { label: "N", key: "\x0e" },
    ],
  },
  {
    title: "Shell",
    items: [
      { label: "ls -la", key: "ls -la" },
      { label: "cd ..", key: "cd .." },
      { label: "pwd", key: "pwd" },
      { label: "git status", key: "git status" },
      { label: "git diff", key: "git diff" },
      { label: "git log", key: "git log --oneline" },
      { label: "clear", key: "clear" },
      { label: "exit", key: "exit" },
      { label: "!!", key: "!!" },
      { label: "!$", key: "!$" },
    ],
  },
  {
    title: "Sym",
    items: [
      { label: "|", key: "|" },
      { label: "&", key: "&" },
      { label: ">", key: ">" },
      { label: ">>", key: ">>" },
      { label: "$()", key: "$()" },
      { label: "${}", key: "${}" },
      { label: "`", key: "`" },
      { label: "~", key: "~" },
      { label: "/", key: "/" },
      { label: "\\", key: "\\" },
      { label: "{}", key: "{}" },
      { label: "[]", key: "[]" },
      { label: "()", key: "()" },
      { label: "'", key: "'" },
      { label: '"', key: '"' },
      { label: "#", key: "#" },
      { label: "*", key: "*" },
      { label: ";", key: ";" },
      { label: "!", key: "!" },
    ],
  },
  {
    title: "Nav",
    items: [
      { label: "Home", key: "\x1b[H" },
      { label: "End", key: "\x1b[F" },
      { label: "PgUp", key: "\x1b[5~" },
      { label: "PgDn", key: "\x1b[6~" },
      { label: "Del", key: "\x1b[3~" },
      { label: "Ins", key: "\x1b[2~" },
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

const LONG_PRESS_MS = 300;

function haptic() {
  navigator.vibrate?.(10);
}

// ── Component ───────────────────────────────────────────────────────

export function MobileKeyboardToolbar({
  onKeyPress,
  ctrlActive = false,
  altActive = false,
  onCtrlToggle,
  onAltToggle,
}: MobileKeyboardToolbarProps) {
  const [expanded, setExpanded] = useState(false);
  const [popup, setPopup] = useState<{
    label: string;
    key: string;
    x: number;
    y: number;
  } | null>(null);

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const clearTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // ── Primary key handlers ────────────────────────────────────────

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, keyDef: KeyDef) => {
      e.preventDefault();
      longPressFired.current = false;

      if (popup) {
        setPopup(null);
        return;
      }

      if (keyDef.longPress) {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        longPressTimer.current = setTimeout(() => {
          longPressFired.current = true;
          haptic();
          setPopup({
            label: keyDef.longPress!.label,
            key: keyDef.longPress!.key,
            x: rect.left + rect.width / 2,
            y: rect.top,
          });
        }, LONG_PRESS_MS);
      }
    },
    [popup],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent, keyDef: KeyDef) => {
      e.preventDefault();
      clearTimer();

      if (longPressFired.current) return;

      haptic();

      if (keyDef.action === "snippets") {
        setExpanded((prev) => !prev);
        return;
      }
      if (keyDef.modifier === "ctrl") {
        onCtrlToggle?.();
        return;
      }
      if (keyDef.modifier === "alt") {
        onAltToggle?.();
        return;
      }
      if (keyDef.key) {
        onKeyPress(keyDef.key);
      }
    },
    [clearTimer, onKeyPress, onCtrlToggle, onAltToggle],
  );

  const handlePointerCancel = useCallback(() => {
    clearTimer();
    longPressFired.current = false;
  }, [clearTimer]);

  // ── Snippet item handler ────────────────────────────────────────

  const handleSnippetTap = useCallback(
    (e: React.PointerEvent, key: string) => {
      e.preventDefault();
      haptic();
      onKeyPress(key);
    },
    [onKeyPress],
  );

  // ── Dismiss long-press popup on outside tap ─────────────────────

  useEffect(() => {
    if (!popup) return;
    const dismiss = () => setPopup(null);
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", dismiss, { once: true });
    }, 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [popup]);

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="w-full bg-[#1e1e1e]">
      {/* Primary toolbar row */}
      <div className="relative flex gap-1 px-1 py-1">
        {TOOLBAR_KEYS.map((keyDef) => (
          <button
            key={keyDef.label}
            type="button"
            onPointerDown={(e) => handlePointerDown(e, keyDef)}
            onPointerUp={(e) => handlePointerUp(e, keyDef)}
            onPointerCancel={handlePointerCancel}
            className={cn(
              "h-10 rounded text-xs font-mono transition-colors select-none touch-manipulation",
              keyDef.icon ? "w-8 shrink-0" : "flex-1",
              keyDef.action === "snippets" && expanded
                ? "bg-[#3a3a3a] text-white"
                : keyDef.modifier === "ctrl" && ctrlActive
                  ? "bg-[#2563eb] text-white border-b-2 border-[#60a5fa]"
                  : keyDef.modifier === "alt" && altActive
                    ? "bg-[#2563eb] text-white border-b-2 border-[#60a5fa]"
                    : "bg-[#2a2a2a] text-[#d4d4d4] active:bg-[#3a3a3a]",
            )}
          >
            {keyDef.label}
          </button>
        ))}

        {/* Long-press popup */}
        {popup && (
          <div
            className="fixed z-50"
            style={{
              left: popup.x,
              top: popup.y - 8,
              transform: "translate(-50%, -100%)",
            }}
          >
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                haptic();
                onKeyPress(popup.key);
                setPopup(null);
              }}
              className="rounded-lg bg-[#3a3a3a] px-4 py-2 text-sm font-mono text-white shadow-lg border border-[#555] select-none touch-manipulation"
            >
              {popup.label}
            </button>
          </div>
        )}
      </div>

      {/* Expandable snippet rows */}
      {expanded && (
        <div className="flex flex-col gap-px border-t border-[#333]">
          {SNIPPET_ROWS.map((row) => (
            <div key={row.title} className="flex items-center">
              {/* Section label */}
              <div className="w-10 shrink-0 pl-2 text-[10px] font-semibold text-[#666] uppercase">
                {row.title}
              </div>
              {/* Horizontal scroll area */}
              <div className="flex-1 overflow-x-auto overscroll-x-contain scrollbar-none">
                <div className="flex gap-1 px-1 py-1">
                  {row.items.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      onPointerDown={(e) => handleSnippetTap(e, item.key)}
                      className="h-8 shrink-0 rounded bg-[#2a2a2a] px-2.5 text-xs font-mono text-[#d4d4d4] active:bg-[#3a3a3a] select-none touch-manipulation whitespace-nowrap"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
