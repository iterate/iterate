import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@iterate-com/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/popover";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { isItxTransportError } from "iterate/sdk/itx/react";
import {
  activeComposerSuggestion,
  applyComposerSuggestion,
  type ActiveComposerSuggestion,
  type ComposerSuggestion,
  type ComposerSuggestionProvider,
} from "~/components/composer-suggestions.ts";

function handleComposerKeyDown({
  event,
  open,
  suggestions,
  selectedIndex,
  activeToken,
  choose,
  setSelectedId,
  setDismissedToken,
  onSubmit,
}: {
  event: KeyboardEvent<HTMLTextAreaElement>;
  open: boolean;
  suggestions: readonly ComposerSuggestion[];
  selectedIndex: number;
  activeToken: string | null;
  choose: (suggestion: ComposerSuggestion) => void;
  setSelectedId: (id: string) => void;
  setDismissedToken: (token: string | null) => void;
  onSubmit: () => void;
}) {
  if (event.nativeEvent.isComposing) return;
  if (open && suggestions.length > 0) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (selectedIndex + direction + suggestions.length) % suggestions.length;
      const next = suggestions[nextIndex];
      if (next !== undefined) setSelectedId(next.id);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const selected = suggestions[selectedIndex];
      if (selected !== undefined) choose(selected);
      return;
    }
  }
  if (open && event.key === "Escape") {
    event.preventDefault();
    setDismissedToken(activeToken);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    onSubmit();
  }
}

function ComposerSuggestionMenu({
  listId,
  active,
  isPending,
  error,
  suggestions,
  selectedId,
  onSelectedIdChange,
  onChoose,
  onRetry,
}: {
  listId: string;
  active: ActiveComposerSuggestion;
  isPending: boolean;
  error: Error | null;
  suggestions: readonly ComposerSuggestion[];
  selectedId: string;
  onSelectedIdChange: (id: string) => void;
  onChoose: (suggestion: ComposerSuggestion) => void;
  onRetry: () => void;
}) {
  return (
    <Command shouldFilter={false} value={selectedId} onValueChange={onSelectedIdChange}>
      <CommandList id={listId} className="max-h-[min(18rem,50svh)]">
        {suggestionMenuContent({ active, isPending, error, suggestions, onChoose, onRetry })}
      </CommandList>
    </Command>
  );
}

function suggestionMenuContent({
  active,
  isPending,
  error,
  suggestions,
  onChoose,
  onRetry,
}: {
  active: ActiveComposerSuggestion;
  isPending: boolean;
  error: Error | null;
  suggestions: readonly ComposerSuggestion[];
  onChoose: (suggestion: ComposerSuggestion) => void;
  onRetry: () => void;
}) {
  const label = active.provider.label.toLocaleLowerCase();
  if (isPending) {
    return (
      <CommandEmpty className="flex items-center justify-center gap-2" role="status">
        <Spinner />
        Loading {label}…
      </CommandEmpty>
    );
  }
  if (error !== null) {
    return (
      <CommandEmpty className="flex flex-col items-center gap-2 px-4" role="alert">
        <span>
          Couldn’t load {label}: {error.message}
        </span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </CommandEmpty>
    );
  }
  if (suggestions.length === 0) return <CommandEmpty>No matching {label}.</CommandEmpty>;
  return (
    <CommandGroup heading={active.provider.label}>
      {suggestions.map((suggestion) => (
        <CommandItem
          key={suggestion.id}
          value={suggestion.id}
          onPointerDown={(event) => event.preventDefault()}
          onSelect={() => onChoose(suggestion)}
        >
          {suggestion.icon}
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{suggestion.label}</span>
          {suggestion.description === undefined ? null : (
            <span className="max-w-1/2 truncate text-xs text-muted-foreground">
              {suggestion.description}
            </span>
          )}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

export function ComposerTextarea({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  providers = [],
  textareaRef,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  providers?: readonly ComposerSuggestionProvider[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const listId = useId();
  const triggerId = useId();
  const [caret, setCaret] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const pendingCaretRef = useRef<number | null>(null);
  const active = activeComposerSuggestion(value, caret, providers);
  const activeToken =
    active === null ? null : `${active.provider.id}:${active.from}:${active.query}`;
  const search = useQuery({
    queryKey: [
      "composer-suggestions",
      active?.provider.id,
      ...(active?.provider.cacheKey ?? []),
      active?.query,
    ],
    queryFn: active === null ? skipToken : () => active.provider.search(active.query),
    staleTime: 30_000,
    retry: (failureCount, error) => isItxTransportError(error) && failureCount < 3,
  });
  const suggestions = search.data ?? [];
  const availableSelectedId = suggestions.some((suggestion) => suggestion.id === selectedId)
    ? selectedId
    : (suggestions[0]?.id ?? "");
  const availableSelectedIndex = suggestions.findIndex(
    (suggestion) => suggestion.id === availableSelectedId,
  );
  const open = focused && active !== null && activeToken !== dismissedToken;

  useLayoutEffect(() => {
    const pendingCaret = pendingCaretRef.current;
    if (pendingCaret === null) return;
    pendingCaretRef.current = null;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(pendingCaret, pendingCaret);
  }, [textareaRef, value]);

  function choose(suggestion: ComposerSuggestion) {
    if (active === null) return;
    const completion = applyComposerSuggestion(value, active, suggestion);
    pendingCaretRef.current = completion.caret;
    setCaret(completion.caret);
    setDismissedToken(null);
    onValueChange(completion.value);
  }

  const textarea = (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(event) => {
        setCaret(event.target.selectionStart);
        setDismissedToken(null);
        onValueChange(event.target.value);
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onSelect={(event) => {
        setCaret(event.currentTarget.selectionStart);
        setDismissedToken(null);
      }}
      onKeyDown={(event) =>
        handleComposerKeyDown({
          event,
          open,
          suggestions,
          selectedIndex: Math.max(0, availableSelectedIndex),
          activeToken,
          choose,
          setSelectedId,
          setDismissedToken,
          onSubmit,
        })
      }
      rows={1}
      role="combobox"
      aria-autocomplete="list"
      aria-controls={listId}
      aria-expanded={open}
      aria-label={placeholder}
      placeholder={placeholder}
      className="field-sizing-content max-h-32 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base leading-snug outline-none"
    />
  );

  return (
    <Popover
      open={open}
      triggerId={triggerId}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setDismissedToken(activeToken);
      }}
    >
      <PopoverTrigger id={triggerId} nativeButton={false} render={textarea} />
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={false}
        finalFocus={false}
        className="w-(--anchor-width) max-w-(--available-width) gap-0 p-0"
      >
        {active === null ? null : (
          <ComposerSuggestionMenu
            listId={listId}
            active={active}
            isPending={search.isPending}
            error={search.error}
            suggestions={suggestions}
            selectedId={availableSelectedId}
            onSelectedIdChange={setSelectedId}
            onChoose={choose}
            onRetry={() => void search.refetch()}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
