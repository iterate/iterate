import { useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "./button.tsx";
import { Spinner } from "./spinner.tsx";

/** CONNECT A PROVIDER — or ask it for more: one button that asks `connect` where to send the
 *  browser and goes there. `connect` is the caller's own call — `itx.integrations.connect(provider,
 *  { scopes, connection, next })` on a project's context or on `session.user` — so the button knows
 *  no SDK, no owner and no provider list: its label is the caller's. Naming an existing
 *  `connection` with more `scopes` asks the same account for them. The spinner stays up while the
 *  browser leaves; a refusal comes back to `onError`. */
export function ConnectButton<Provider extends string>({
  provider,
  scopes,
  connection,
  connect,
  onError,
  children,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick" | "onError"> & {
  provider: Provider;
  scopes?: string[];
  connection?: string;
  children: ReactNode;
  connect: (input: {
    provider: Provider;
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
      {children}
    </Button>
  );
}
