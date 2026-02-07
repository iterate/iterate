import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils.ts";

interface MobileKeyboardToolbarProps {
  onKeyPress: (key: string) => void;
  ctrlActive?: boolean;
  onCtrlToggle?: () => void;
  onDismissKeyboard?: () => void;
  onSearch?: (query: string) => void;
  onSearchNext?: (query: string) => void;
  onSearchPrev?: (query: string) => void;
  onSearchClose?: () => void;
}

interface KeyDef {
  label: string;
  key?: string;
  modifier?: "ctrl";
  action?: "snippets" | "arrows" | "dismiss-kb" | "search";
  longPress?: { label: string; key: string };
  /** Fire repeatedly while held (initial delay then fast interval) */
  repeat?: boolean;
  /** Render at fixed narrow width (icons, symbols, arrows) */
  icon?: boolean;
}

const TOOLBAR_KEYS: KeyDef[] = [
  { label: "snippets", action: "snippets", icon: true },
  { label: "Tab", key: "\t", longPress: { label: "~", key: "~" } },
  { label: "Esc", key: "\x1b", longPress: { label: "`", key: "`" } },
  { label: "Ctrl", modifier: "ctrl" },
  { label: "-", key: "-", icon: true, longPress: { label: "|", key: "|" } },
  { label: "/", key: "/", icon: true, longPress: { label: "\\", key: "\\" } },
  { label: "search", action: "search", icon: true },
  { label: "arrows", action: "arrows", icon: true },
  { label: "⌨", action: "dismiss-kb", icon: true },
  { label: "⌫", key: "\x7f", icon: true, repeat: true },
];

// ── Arrow key definitions for the popover ────────────────────────────

interface ArrowKeyDef {
  label: string;
  key: string;
  longPress?: { label: string; key: string };
}

const ARROW_KEYS: ArrowKeyDef[] = [
  { label: "↑", key: "\x1b[A", longPress: { label: "PgUp", key: "\x1b[5~" } },
  { label: "↓", key: "\x1b[B", longPress: { label: "PgDn", key: "\x1b[6~" } },
  { label: "←", key: "\x1b[D", longPress: { label: "Home", key: "\x1b[H" } },
  { label: "→", key: "\x1b[C", longPress: { label: "End", key: "\x1b[F" } },
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

// Expandable rows behind chevron toggle
const SNIPPET_ROWS: SnippetRow[] = [
  {
    title: "Shell",
    items: [
      { label: "pi", key: "pi" },
      { label: "opencode", key: "opencode" },
      { label: "claude", key: "claude" },
      { label: "codex", key: "codex" },
      { label: "tmux", key: "tmux" },
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
      { label: "/", key: "/" },
      { label: "\\", key: "\\" },
      { label: "|", key: "|" },
      { label: "&", key: "&" },
      { label: ">", key: ">" },
      { label: ">>", key: ">>" },
      { label: "$()", key: "$()" },
      { label: "${}", key: "${}" },
      { label: "`", key: "`" },
      { label: "~", key: "~" },
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
const REPEAT_INITIAL_DELAY_MS = 300;
const REPEAT_INTERVAL_MS = 80;

function haptic() {
  navigator.vibrate?.(10);
}

// ── Component ───────────────────────────────────────────────────────

export function MobileKeyboardToolbar({
  onKeyPress,
  ctrlActive = false,
  onCtrlToggle,
  onDismissKeyboard,
  onSearch,
  onSearchNext,
  onSearchPrev,
  onSearchClose,
}: MobileKeyboardToolbarProps) {
  const [expanded, setExpanded] = useState(false);
  const [arrowsOpen, setArrowsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [popup, setPopup] = useState<{
    label: string;
    key: string;
    x: number;
    y: number;
  } | null>(null);

  const arrowBtnRef = useRef<HTMLButtonElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const clearRepeat = useCallback(() => {
    if (repeatTimer.current) {
      clearTimeout(repeatTimer.current);
      repeatTimer.current = null;
    }
    if (repeatInterval.current) {
      clearInterval(repeatInterval.current);
      repeatInterval.current = null;
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

      // Auto-repeat keys: fire immediately, then repeat on hold
      if (keyDef.repeat && keyDef.key) {
        haptic();
        onKeyPress(keyDef.key);
        const key = keyDef.key;
        repeatTimer.current = setTimeout(() => {
          repeatInterval.current = setInterval(() => {
            haptic();
            onKeyPress(key);
          }, REPEAT_INTERVAL_MS);
        }, REPEAT_INITIAL_DELAY_MS);
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
    [popup, onKeyPress],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent, keyDef: KeyDef) => {
      e.preventDefault();
      clearTimer();
      clearRepeat();

      // Repeat keys already fired on pointerdown — nothing to do on up
      if (keyDef.repeat) return;

      if (longPressFired.current) return;

      haptic();

      if (keyDef.action === "snippets") {
        setExpanded((prev) => !prev);
        return;
      }
      if (keyDef.action === "arrows") {
        setArrowsOpen((prev) => !prev);
        return;
      }
      if (keyDef.action === "search") {
        setSearchOpen((prev) => {
          if (prev) {
            onSearchClose?.();
            return false;
          }
          // Focus input on next tick after render
          setTimeout(() => searchInputRef.current?.focus(), 50);
          return true;
        });
        return;
      }
      if (keyDef.action === "dismiss-kb") {
        onDismissKeyboard?.();
        return;
      }
      if (keyDef.modifier === "ctrl") {
        onCtrlToggle?.();
        return;
      }
      if (keyDef.key) {
        onKeyPress(keyDef.key);
      }
    },
    [clearTimer, clearRepeat, onKeyPress, onCtrlToggle, onDismissKeyboard],
  );

  const handlePointerCancel = useCallback(() => {
    clearTimer();
    clearRepeat();
    longPressFired.current = false;
  }, [clearTimer, clearRepeat]);

  // ── Arrow popover key handler (repeat on hold + long-press) ────

  const handleArrowPointerDown = useCallback(
    (e: React.PointerEvent, arrow: ArrowKeyDef) => {
      e.preventDefault();
      e.stopPropagation();
      longPressFired.current = false;
      haptic();
      onKeyPress(arrow.key);

      // Start repeat
      const key = arrow.key;
      repeatTimer.current = setTimeout(() => {
        repeatInterval.current = setInterval(() => {
          haptic();
          onKeyPress(key);
        }, REPEAT_INTERVAL_MS);
      }, REPEAT_INITIAL_DELAY_MS);

      // Also set up long-press for variant
      if (arrow.longPress) {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        longPressTimer.current = setTimeout(() => {
          longPressFired.current = true;
          clearRepeat();
          haptic();
          setPopup({
            label: arrow.longPress!.label,
            key: arrow.longPress!.key,
            x: rect.left + rect.width / 2,
            y: rect.top,
          });
        }, LONG_PRESS_MS);
      }
    },
    [onKeyPress, clearRepeat],
  );

  const handleArrowPointerUp = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      clearTimer();
      clearRepeat();
    },
    [clearTimer, clearRepeat],
  );

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

  // ── Dismiss arrow popover on outside tap ────────────────────────

  useEffect(() => {
    if (!arrowsOpen) return;
    const dismiss = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-arrow-popover]") || target.closest("[data-arrow-toggle]")) return;
      setArrowsOpen(false);
    };
    // Use a longer delay to avoid the toggle tap's own events from dismissing
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", dismiss);
    }, 200);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [arrowsOpen]);

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="w-full bg-[#1e1e1e]">
      {/* Primary toolbar row */}
      <div className="relative flex gap-1 pb-1">
        {TOOLBAR_KEYS.map((keyDef) => (
          <button
            key={keyDef.label}
            type="button"
            ref={keyDef.action === "arrows" ? arrowBtnRef : undefined}
            data-arrow-toggle={keyDef.action === "arrows" ? "" : undefined}
            onPointerDown={(e) => handlePointerDown(e, keyDef)}
            onPointerUp={(e) => handlePointerUp(e, keyDef)}
            onPointerCancel={handlePointerCancel}
            className={cn(
              "relative h-8 rounded text-[10px] font-mono transition-colors select-none touch-manipulation",
              keyDef.icon ? "w-7 shrink-0" : "min-w-0 flex-1",
              keyDef.action === "snippets" && expanded
                ? "bg-[#3a3a3a] text-white"
                : keyDef.action === "arrows" && arrowsOpen
                  ? "bg-[#3a3a3a] text-white"
                  : keyDef.action === "search" && searchOpen
                    ? "bg-[#3a3a3a] text-white"
                    : keyDef.modifier === "ctrl" && ctrlActive
                      ? "bg-[#2563eb] text-white border-b-2 border-[#60a5fa]"
                      : "bg-[#2a2a2a] text-[#d4d4d4] active:bg-[#3a3a3a]",
            )}
          >
            {/* Special labels for action buttons */}
            {keyDef.action === "snippets" ? (
              <span className={cn("inline-block transition-transform", expanded && "rotate-180")}>
                ▾
              </span>
            ) : keyDef.action === "arrows" ? (
              "⇅"
            ) : keyDef.action === "search" ? (
              "⌕"
            ) : (
              keyDef.label
            )}

            {/* Long-press hint */}
            {keyDef.longPress && (
              <span className="absolute -top-0.5 right-0.5 text-[7px] leading-none text-[#666]">
                {keyDef.longPress.label}
              </span>
            )}
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

        {/* Arrow keys popover */}
        {arrowsOpen && (
          <div
            data-arrow-popover=""
            className="absolute z-50 rounded-lg bg-[#2a2a2a] border border-[#444] shadow-lg p-1"
            style={{
              top: "calc(100% + 4px)",
              right: 0,
            }}
          >
            <div className="grid grid-cols-3 gap-1 w-[108px]">
              {/* Row 1: _ ↑ _ */}
              <div />
              <button
                type="button"
                onPointerDown={(e) => handleArrowPointerDown(e, ARROW_KEYS[0]!)}
                onPointerUp={handleArrowPointerUp}
                onPointerCancel={handlePointerCancel}
                className="relative h-9 w-9 rounded bg-[#3a3a3a] text-sm font-mono text-[#d4d4d4] active:bg-[#555] select-none touch-manipulation"
              >
                ↑
                {ARROW_KEYS[0]!.longPress && (
                  <span className="absolute -top-0.5 right-0.5 text-[6px] leading-none text-[#666]">
                    {ARROW_KEYS[0]!.longPress.label}
                  </span>
                )}
              </button>
              <div />
              {/* Row 2: ← ↓ → */}
              <button
                type="button"
                onPointerDown={(e) => handleArrowPointerDown(e, ARROW_KEYS[2]!)}
                onPointerUp={handleArrowPointerUp}
                onPointerCancel={handlePointerCancel}
                className="relative h-9 w-9 rounded bg-[#3a3a3a] text-sm font-mono text-[#d4d4d4] active:bg-[#555] select-none touch-manipulation"
              >
                ←
                {ARROW_KEYS[2]!.longPress && (
                  <span className="absolute -top-0.5 right-0.5 text-[6px] leading-none text-[#666]">
                    {ARROW_KEYS[2]!.longPress.label}
                  </span>
                )}
              </button>
              <button
                type="button"
                onPointerDown={(e) => handleArrowPointerDown(e, ARROW_KEYS[1]!)}
                onPointerUp={handleArrowPointerUp}
                onPointerCancel={handlePointerCancel}
                className="relative h-9 w-9 rounded bg-[#3a3a3a] text-sm font-mono text-[#d4d4d4] active:bg-[#555] select-none touch-manipulation"
              >
                ↓
                {ARROW_KEYS[1]!.longPress && (
                  <span className="absolute -top-0.5 right-0.5 text-[6px] leading-none text-[#666]">
                    {ARROW_KEYS[1]!.longPress.label}
                  </span>
                )}
              </button>
              <button
                type="button"
                onPointerDown={(e) => handleArrowPointerDown(e, ARROW_KEYS[3]!)}
                onPointerUp={handleArrowPointerUp}
                onPointerCancel={handlePointerCancel}
                className="relative h-9 w-9 rounded bg-[#3a3a3a] text-sm font-mono text-[#d4d4d4] active:bg-[#555] select-none touch-manipulation"
              >
                →
                {ARROW_KEYS[3]!.longPress && (
                  <span className="absolute -top-0.5 right-0.5 text-[6px] leading-none text-[#666]">
                    {ARROW_KEYS[3]!.longPress.label}
                  </span>
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="flex items-center gap-1 pb-1">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value) onSearch?.(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (searchQuery) {
                  if (e.shiftKey) {
                    onSearchPrev?.(searchQuery);
                  } else {
                    onSearchNext?.(searchQuery);
                  }
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSearchOpen(false);
                setSearchQuery("");
                onSearchClose?.();
              }
            }}
            placeholder="Search..."
            className="h-7 min-w-0 flex-1 rounded bg-[#2a2a2a] px-2 text-xs font-mono text-[#d4d4d4] placeholder-[#666] outline-none focus:ring-1 focus:ring-[#555]"
          />
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              if (searchQuery) onSearchPrev?.(searchQuery);
            }}
            className="h-7 w-7 shrink-0 rounded bg-[#2a2a2a] text-xs font-mono text-[#d4d4d4] active:bg-[#3a3a3a] select-none touch-manipulation"
          >
            ↑
          </button>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              if (searchQuery) onSearchNext?.(searchQuery);
            }}
            className="h-7 w-7 shrink-0 rounded bg-[#2a2a2a] text-xs font-mono text-[#d4d4d4] active:bg-[#3a3a3a] select-none touch-manipulation"
          >
            ↓
          </button>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              setSearchOpen(false);
              setSearchQuery("");
              onSearchClose?.();
            }}
            className="h-7 w-7 shrink-0 rounded bg-[#2a2a2a] text-xs font-mono text-[#d4d4d4] active:bg-[#3a3a3a] select-none touch-manipulation"
          >
            ✕
          </button>
        </div>
      )}

      {/* Expandable snippet rows (Shell, Sym, Nav) */}
      {expanded && (
        <div className="flex flex-col gap-px">
          {SNIPPET_ROWS.map((row) => (
            <div key={row.title} className="flex items-center">
              <div className="w-10 shrink-0 text-[10px] font-semibold text-[#666] uppercase">
                {row.title}
              </div>
              <div className="flex-1 overflow-x-auto overscroll-x-contain scrollbar-none">
                <div className="flex gap-1 py-1">
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
