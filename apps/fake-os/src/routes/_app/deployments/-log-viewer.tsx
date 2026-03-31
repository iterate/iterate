import { useEffect, useRef, useCallback } from "react";
import AnsiToHtml from "ansi-to-html";

const converter = new AnsiToHtml({
  fg: "#d4d4d4",
  bg: "transparent",
  newline: false,
  escapeXML: true,
  colors: {
    0: "#1e1e1e",
    1: "#f44747",
    2: "#6a9955",
    3: "#dcdcaa",
    4: "#569cd6",
    5: "#c586c0",
    6: "#4ec9b0",
    7: "#d4d4d4",
    8: "#808080",
    9: "#f44747",
    10: "#6a9955",
    11: "#dcdcaa",
    12: "#569cd6",
    13: "#c586c0",
    14: "#4ec9b0",
    15: "#d4d4d4",
  },
});

export function LogViewer({ lines }: { lines: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const programmaticScroll = useRef(false);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    programmaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    requestAnimationFrame(scrollToBottom);
  }, [lines.length, scrollToBottom]);

  useEffect(() => {
    requestAnimationFrame(scrollToBottom);
  }, [scrollToBottom]);

  function handleScroll() {
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < 40;
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto bg-[#1e1e1e] p-3 font-mono text-xs leading-5 text-[#d4d4d4] select-text"
    >
      {lines.length === 0 ? (
        <div className="text-[#808080]">Waiting for logs...</div>
      ) : (
        lines.map((line, i) => (
          <div
            key={i}
            className="whitespace-pre-wrap break-all"
            dangerouslySetInnerHTML={{ __html: converter.toHtml(line) }}
          />
        ))
      )}
    </div>
  );
}
