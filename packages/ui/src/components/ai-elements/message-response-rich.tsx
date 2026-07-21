import { math } from "@streamdown/math";
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type StreamdownProps,
} from "streamdown";

export function RichMessageResponse({
  remarkPlugins,
  rehypePlugins,
  ...props
}: StreamdownProps) {
  const mathRemarkPlugin = Array.isArray(math.remarkPlugin)
    ? math.remarkPlugin[0]
    : math.remarkPlugin;
  const mathRehypePlugin = Array.isArray(math.rehypePlugin)
    ? math.rehypePlugin[0]
    : math.rehypePlugin;

  return (
    <Streamdown
      remarkPlugins={[
        ...(remarkPlugins || Object.values(defaultRemarkPlugins)).filter(
          (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) !== mathRemarkPlugin,
        ),
        math.remarkPlugin,
      ]}
      rehypePlugins={[
        ...(rehypePlugins || Object.values(defaultRehypePlugins)).filter(
          (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) !== mathRehypePlugin,
        ),
        math.rehypePlugin,
      ]}
      {...props}
    />
  );
}
