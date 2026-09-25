import { useState, type ComponentProps } from "react";
import { Button } from "./button.tsx";
import { Spinner } from "./spinner.tsx";

/** The providers a connection is made to. */
export type ConnectProvider = "slack" | "google" | "cloudflare" | "github";

const TITLES: Record<ConnectProvider, string> = {
  slack: "Slack",
  google: "Google",
  cloudflare: "Cloudflare",
  github: "GitHub",
};

/** CONNECT A PROVIDER — or ask it for more: one button that asks `connect` where to send the
 *  browser and goes there. `connect` is the caller's own call — `itx.integrations.connect(provider,
 *  { scopes, connection, next })` on a project's context or on `session.user` — so the button knows
 *  no SDK and no owner. Naming an existing `connection` with more `scopes` asks the same account for
 *  them. The spinner stays up while the browser leaves; a refusal comes back to `onError`. */
export function ConnectButton({
  provider,
  scopes,
  connection,
  connect,
  onError,
  children,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick" | "onError"> & {
  provider: ConnectProvider;
  scopes?: string[];
  connection?: string;
  connect: (input: {
    provider: ConnectProvider;
    scopes?: string[];
    connection?: string;
  }) => Promise<{ authorizationUrl: string }>;
  onError?: (error: unknown) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const start = async () => {
    setLeaving(true);
    try {
      const { authorizationUrl } = await connect({ provider, scopes, connection });
      window.location.assign(authorizationUrl);
    } catch (error) {
      setLeaving(false);
      onError?.(error);
    }
  };
  return (
    <Button {...props} disabled={disabled || leaving} onClick={() => void start()}>
      {leaving ? <Spinner data-icon="inline-start" /> : null}
      {children ?? `Connect ${TITLES[provider]}`}
    </Button>
  );
}
