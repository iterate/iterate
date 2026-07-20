export function sidebarAgentRowsVisible(input: {
  isMobile: boolean;
  openMobile: boolean;
  state: "collapsed" | "expanded";
}): boolean {
  return input.isMobile ? input.openMobile : input.state === "expanded";
}
