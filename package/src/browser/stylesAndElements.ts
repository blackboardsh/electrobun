export const isAppRegionDrag = (e: MouseEvent) => {
  return (e.target as HTMLElement)?.classList?.contains("electrobun-webkit-app-region-drag");
};
