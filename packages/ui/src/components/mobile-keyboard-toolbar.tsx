import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "../lib/utils.ts";

interface MobileKeyboardToolbarProps {
  onKeyPress: (key: string) => void;
  ctrlActive?: boolean;
  keyboardVisible?: boolean;
  onCtrlToggle?: () => void;
  onToggleKeyboard?: () => void;
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
  repeat?: boolean;
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

const LONG_PRESS_MS = 300;
const REPEAT_INITIAL_DELAY_MS = 300;
const REPEAT_INTERVAL_MS = 80;

function haptic() {
  navigator.vibrate?.(10);
}

export function MobileKeyboardToolbar({
  onKeyPress,
  ctrlActive = false,
  keyboardVisible = false,
  onCtrlToggle,
  onToggleKeyboard,
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

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const popupDismissed = useRef(false);
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

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      if (repeatTimer.current) clearTimeout(repeatTimer.current);
      if (repeatInterval.current) clearInterval(repeatInterval.current);
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent, keyDef: KeyDef) => {
      event.preventDefault();
      longPressFired.current = false;
      popupDismissed.current = false;

      if (popup) {
        setPopup(null);
        popupDismissed.current = true;
        return;
      }

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
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
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
    (event: React.PointerEvent, keyDef: KeyDef) => {
      event.preventDefault();
      clearTimer();
      clearRepeat();

      if (keyDef.repeat) return;
      if (longPressFired.current) return;
      if (popupDismissed.current) return;

      haptic();

      if (keyDef.action === "snippets") {
        setExpanded((previous) => !previous);
        return;
      }
      if (keyDef.action === "arrows") {
        setArrowsOpen((previous) => !previous);
        return;
      }
      if (keyDef.action === "search") {
        setSearchOpen((previous) => {
          if (previous) {
            setSearchQuery("");
            onSearchClose?.();
            return false;
          }
          setTimeout(() => searchInputRef.current?.focus(), 50);
          return true;
        });
        return;
      }
      if (keyDef.action === "dismiss-kb") {
        onToggleKeyboard?.();
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
    [clearTimer, clearRepeat, onKeyPress, onCtrlToggle, onToggleKeyboard, onSearchClose],
  );

  const handlePointerCancel = useCallback(() => {
    clearTimer();
    clearRepeat();
    longPressFired.current = false;
  }, [clearTimer, clearRepeat]);

  const handleArrowPointerDown = useCallback(
    (event: React.PointerEvent, arrow: ArrowKeyDef) => {
      event.preventDefault();
      event.stopPropagation();
      longPressFired.current = false;
      haptic();
      onKeyPress(arrow.key);

      const key = arrow.key;
      repeatTimer.current = setTimeout(() => {
        repeatInterval.current = setInterval(() => {
          haptic();
          onKeyPress(key);
        }, REPEAT_INTERVAL_MS);
      }, REPEAT_INITIAL_DELAY_MS);

      if (arrow.longPress) {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
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
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      clearTimer();
      clearRepeat();
    },
    [clearTimer, clearRepeat],
  );

  const handleSnippetTap = useCallback(
    (key: string) => {
      haptic();
      onKeyPress(key);
    },
    [onKeyPress],
  );

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

  useEffect(() => {
    if (!arrowsOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-arrow-popover]") || target.closest("[data-arrow-toggle]")) return;
      setArrowsOpen(false);
    };
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", dismiss);
    }, 200);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [arrowsOpen]);

  return (
    <div className="w-full bg-[#1e1e1e]">
      <div className="relative flex gap-1 pb-1">
        {TOOLBAR_KEYS.map((keyDef) => (
          <button
            key={keyDef.label}
            type="button"
            data-arrow-toggle={keyDef.action === "arrows" ? "" : undefined}
            onPointerDown={(event) => handlePointerDown(event, keyDef)}
            onPointerUp={(event) => handlePointerUp(event, keyDef)}
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
                    : keyDef.action === "dismiss-kb" && keyboardVisible
                      ? "bg-[#3a3a3a] text-white"
                      : keyDef.modifier === "ctrl" && ctrlActive
                        ? "bg-[#2563eb] text-white border-b-2 border-[#60a5fa]"
                        : "bg-[#2a2a2a] text-[#d4d4d4] active:bg-[#3a3a3a]",
            )}
          >
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

            {keyDef.longPress && (
              <span className="absolute -top-0.5 right-0.5 text-[7px] leading-none text-[#666]">
                {keyDef.longPress.label}
              </span>
            )}
          </button>
        ))}

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
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                haptic();
                onKeyPress(popup.key);
                setPopup(null);
              }}
              className="rounded-lg border border-[#555] bg-[#3a3a3a] px-4 py-2 text-sm font-mono text-white shadow-lg select-none touch-manipulation"
            >
              {popup.label}
            </button>
          </div>
        )}

        {arrowsOpen && (
          <div
            data-arrow-popover=""
            className="absolute z-50 rounded-lg border border-[#444] bg-[#2a2a2a] p-1 shadow-lg"
            style={{
              top: "calc(100% + 4px)",
              right: 0,
            }}
          >
            <div className="grid w-[108px] grid-cols-3 gap-1">
              <div />
              <button
                type="button"
                onPointerDown={(event) => handleArrowPointerDown(event, ARROW_KEYS[0]!)}
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
              <button
                type="button"
                onPointerDown={(event) => handleArrowPointerDown(event, ARROW_KEYS[2]!)}
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
                onPointerDown={(event) => handleArrowPointerDown(event, ARROW_KEYS[1]!)}
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
                onPointerDown={(event) => handleArrowPointerDown(event, ARROW_KEYS[3]!)}
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

      {searchOpen && (
        <div className="flex items-center gap-1 pb-1">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              if (event.target.value) onSearch?.(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (searchQuery) {
                  if (event.shiftKey) {
                    onSearchPrev?.(searchQuery);
                  } else {
                    onSearchNext?.(searchQuery);
                  }
                }
              }
              if (event.key === "Escape") {
                event.preventDefault();
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
            onPointerDown={(event) => {
              event.preventDefault();
              if (searchQuery) onSearchPrev?.(searchQuery);
            }}
            className="h-7 w-7 shrink-0 rounded bg-[#2a2a2a] text-xs font-mono text-[#d4d4d4] active:bg-[#3a3a3a] select-none touch-manipulation"
          >
            ↑
          </button>
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
              if (searchQuery) onSearchNext?.(searchQuery);
            }}
            className="h-7 w-7 shrink-0 rounded bg-[#2a2a2a] text-xs font-mono text-[#d4d4d4] active:bg-[#3a3a3a] select-none touch-manipulation"
          >
            ↓
          </button>
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault();
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
                      onPointerUp={() => handleSnippetTap(item.key)}
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
