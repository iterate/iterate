import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import { toast } from "@iterate-com/ui/components/sonner";

export function ProjectHostnameCard({
  copyLabel,
  description,
  hostname,
  openLabel,
  url,
}: {
  copyLabel: string;
  description: string;
  hostname: string;
  openLabel: string;
  url: string | null;
}) {
  const displayHost = hostFromUrl(url) ?? hostname;
  const appHostPattern = `<app>.${displayHost}`;

  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{displayHost}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label={`${copyLabel} ${displayHost}`}
            onClick={() => copyToClipboard(displayHost)}
            size="icon-xs"
            type="button"
            variant="outline"
          >
            <CopyIcon aria-hidden="true" />
          </Button>
          {url ? (
            <Button
              aria-label={`${openLabel} ${displayHost}`}
              render={
                <a href={url} target="_blank" rel="noreferrer">
                  <span className="sr-only">{openLabel}</span>
                </a>
              }
              size="icon-xs"
              type="button"
              variant="outline"
            >
              <ExternalLinkIcon aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="grid gap-1 text-xs">
        <p className="text-muted-foreground">Apps route from subdomains on the same host.</p>
        <code className="min-w-0 rounded bg-muted px-1.5 py-1 break-all">{appHostPattern}</code>
      </div>
    </div>
  );
}

function copyToClipboard(value: string) {
  if (!navigator.clipboard) {
    toast.error("Clipboard unavailable");
    return;
  }
  void navigator.clipboard.writeText(value).then(
    () => toast.success("Copied"),
    () => toast.error("Could not copy"),
  );
}

function hostFromUrl(url: string | null) {
  if (!url || !URL.canParse(url)) return null;
  return new URL(url).host;
}
