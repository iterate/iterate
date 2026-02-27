import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";

// oxlint-disable-next-line react/only-export-components -- not a component, integration config object
export default {
  name: "Tanstack Query",
  render: <ReactQueryDevtoolsPanel />,
};
