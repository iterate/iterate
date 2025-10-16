import { type ComponentProps, memo } from "react";
import Markdown from "react-markdown";

type ResponseProps = ComponentProps<typeof Markdown>;

export const Response = memo(
  ({ className, ...props }: ResponseProps & { className?: string }) => (
    <div className={className}>
      <Markdown {...props} />
    </div>
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

Response.displayName = "Response";
