import ElectrobunEvent from "./event";

export default {
  willNavigate: (data) =>
    new ElectrobunEvent<{ url: string; windowId: number }, { allow: boolean }>(
      "will-navigate",
      data
    ),
  didNavigate: (data) =>
    new ElectrobunEvent<{ detail: string }, {}>("did-navigate", data),
  didNavigateInPage: (data) =>
    new ElectrobunEvent<{ detail: string }, {}>("did-navigate-in-page", data),
  didCommitNavigation: (data) =>
    new ElectrobunEvent<{ detail: string }, {}>("did-commit-navigation", data),
  domReady: (data) =>
    new ElectrobunEvent<{ detail: string }, {}>("dom-ready", data),
};
