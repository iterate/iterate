/** @jsxImportSource @opentui/react */
import { Component, type ReactNode } from "react";
import { COLORS } from "./chat-colors.ts";

export function LoadingTerminal() {
  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center">
      <text fg={COLORS.textMuted}>Loading agent history…</text>
    </box>
  );
}

export class TerminalErrorBoundary extends Component<
  { children: ReactNode },
  { message: string | null }
> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.message != null) {
      return (
        <box width="100%" height="100%" flexDirection="column" padding={1}>
          <text fg={COLORS.danger}>Iterate chat failed</text>
          <text fg={COLORS.textMuted}>{this.state.message}</text>
        </box>
      );
    }
    return this.props.children;
  }
}
