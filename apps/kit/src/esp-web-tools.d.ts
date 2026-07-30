import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "esp-web-install-button": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        manifest?: string;
      };
    }
  }
}
