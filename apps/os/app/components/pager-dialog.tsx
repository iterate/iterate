import { useEffect } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog.tsx";

/**
 * Generic pager dialog – shows an item from an array and allows navigation
 * via buttons or ←/→ keys. Keeps the footer layout identical across usages.
 */
export function PagerDialog<T>({
  open,
  onOpenChange,
  items,
  selectedIndex,
  onSelectedIndexChange,
  title,
  render,
  size = "default",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: T[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  title: (item: T, index: number) => React.ReactNode;
  render: (item: T) => React.ReactNode;
  size?: "default" | "large";
}) {
  // Keyboard navigation
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (selectedIndex > 0) {
          onSelectedIndexChange(selectedIndex - 1);
        }
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (selectedIndex < items.length - 1) {
          onSelectedIndexChange(selectedIndex + 1);
        }
      }
    }
    if (open) {
      window.addEventListener("keydown", handler);
    }
    return () => window.removeEventListener("keydown", handler);
  }, [open, selectedIndex, items.length, onSelectedIndexChange]);

  const item = items[selectedIndex];

  const sizeClasses =
    size === "large"
      ? "!w-[80vw] !max-w-[80vw] !h-[80vh] !max-h-[80vh]"
      : "!w-[95vw] !max-w-[95vw] !h-[90vh] !max-h-[90vh]";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`${sizeClasses} flex flex-col overflow-hidden`}
        style={
          size === "large"
            ? { width: "80vw", maxWidth: "80vw", height: "80vh", maxHeight: "80vh" }
            : { width: "95vw", maxWidth: "95vw", height: "90vh", maxHeight: "90vh" }
        }
      >
        <DialogHeader>
          <DialogTitle>{title(item, selectedIndex)}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto">{render(item)}</div>

        <DialogFooter className="flex justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSelectedIndexChange(Math.max(0, selectedIndex - 1))}
            disabled={selectedIndex === 0}
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSelectedIndexChange(Math.min(items.length - 1, selectedIndex + 1))}
            disabled={selectedIndex === items.length - 1}
          >
            Next <ArrowRight className="h-4 w-4 ml-1" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
