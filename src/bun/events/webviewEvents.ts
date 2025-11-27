import ElectrobunEvent from "./event";

export default {
  willNavigate: (data) =>
    new ElectrobunEvent<{ detail: string }, {}>("will-navigate", data),
  didNavigate: (data) =>
    new ElectrobunEvent<{ detail: string }, {}>("did-navigate", data),
  didNavigateInPage: (data) =>
    new ElectrobunEvent<{ detail: string }, {}>("did-navigate-in-page", data),
  didCommitNavigation: (data) =>
    new ElectrobunEvent<{ detail: string }, {}>("did-commit-navigation", data),
  domReady: (data) =>
    new ElectrobunEvent<{ detail: string }, {}>("dom-ready", data),
  newWindowOpen: (data) =>
    new ElectrobunEvent<{
      detail: string | {
        url: string;
        isCmdClick: boolean;
        modifierFlags?: number;
        targetDisposition?: number;
        userGesture?: boolean;
      }
    }, {}>("new-window-open", data),
  hostMessage: (data) =>
    new ElectrobunEvent<{ detail: string }, {}>("host-message", data),
};
