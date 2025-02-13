export const isAppRegionDrag = (e: MouseEvent) => {
  return e.target?.classList.contains("electrobun-webkit-app-region-drag") ||
    e.target?.attributes["electrobun-webkit-app-region-drag"] !== undefined;
};
