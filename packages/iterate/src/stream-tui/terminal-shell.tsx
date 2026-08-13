/** @jsxImportSource @opentui/react */
import { Component, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { COLORS } from "./chat-colors.ts";

export function LoadingTerminal() {
  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center">
      <text fg={COLORS.textMuted}>Loading agent history…</text>
    </box>
  );
}

export class TerminalErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { message: string | null }
> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  private readonly retry = () => {
    this.props.onReset();
    this.setState({ message: null });
  };

  render() {
    if (this.state.message) {
      return <TerminalFailure message={this.state.message} onRetry={this.retry} />;
    }
    return this.props.children;
  }
}

function TerminalFailure(props: { message: string; onRetry: () => void }) {
  useKeyboard((key) => {
    if (key.ctrl && key.name === "r") props.onRetry();
  });

  return (
    <box width="100%" height="100%" flexDirection="column" padding={1}>
      <text fg={COLORS.danger}>Iterate chat failed</text>
      <text fg={COLORS.textMuted}>{props.message}</text>
      <text fg={COLORS.textMuted}>Ctrl+R to retry</text>
    </box>
  );
}
