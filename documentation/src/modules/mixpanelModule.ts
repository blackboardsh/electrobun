import mixpanel from "mixpanel-browser";

const initMixpanel = () => {
  // if (typeof window !== undefined) {
  mixpanel.init("3a0027a9f6bab6bbeb09e1d28901fc7c", {
    persistence: "localStorage",
  });

  function trackPage() {
    if (document.location.hostname.includes("electrobun.dev")) {
      mixpanel.track("Page View", {
        path: window.location.pathname,
      });
    }
  }

  window.addEventListener("popstate", () => {
    trackPage();
  });

  const originalPushState = window.history.pushState;
  window.history.pushState = function (...args) {
    // Call original pushState first
    originalPushState.apply(this, args);
    // Then track a new page view
    trackPage();
  };

  // 3) Similarly, override replaceState
  const originalReplaceState = window.history.replaceState;
  window.history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    trackPage();
  };

  trackPage();
};

if (typeof window !== "undefined") {
  initMixpanel();
}
