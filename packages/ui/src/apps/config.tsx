import { createContext, createElement, useContext, type ReactNode } from "react";

const ConfigContext = createContext<unknown>(undefined);

export function ConfigProvider<TConfig>(props: { value: TConfig; children: ReactNode }) {
  return createElement(ConfigContext.Provider, { value: props.value }, props.children);
}

// oxlint-disable-next-line react/only-export-components -- hook is colocated with ConfigProvider
export function useConfig<TConfig>() {
  const value = useContext(ConfigContext);
  if (value === undefined) {
    throw new Error("useConfig must be used within a ConfigProvider.");
  }

  return value as TConfig;
}
