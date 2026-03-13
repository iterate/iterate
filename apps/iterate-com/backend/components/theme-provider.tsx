import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps } from "next-themes";

export function ThemeProvider(props: React.PropsWithChildren<ThemeProviderProps>) {
  return <NextThemesProvider {...props} />;
}
