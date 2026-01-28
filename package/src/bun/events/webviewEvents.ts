import ElectrobunEvent from "./event";

type DetailData = { detail: string };
type NewWindowOpenData = {
  detail: string | {
    url: string;
    isCmdClick: boolean;
    modifierFlags?: number;
    targetDisposition?: number;
    userGesture?: boolean;
  }
};

export default {
  willNavigate: (data: DetailData) =>
    new ElectrobunEvent<DetailData, {}>("will-navigate", data),
  didNavigate: (data: DetailData) =>
    new ElectrobunEvent<DetailData, {}>("did-navigate", data),
  didNavigateInPage: (data: DetailData) =>
    new ElectrobunEvent<DetailData, {}>("did-navigate-in-page", data),
  didCommitNavigation: (data: DetailData) =>
    new ElectrobunEvent<DetailData, {}>("did-commit-navigation", data),
  domReady: (data: DetailData) =>
    new ElectrobunEvent<DetailData, {}>("dom-ready", data),
  newWindowOpen: (data: NewWindowOpenData) =>
    new ElectrobunEvent<NewWindowOpenData, {}>("new-window-open", data),
  hostMessage: (data: DetailData) =>
    new ElectrobunEvent<DetailData, {}>("host-message", data),
  downloadStarted: (data: DetailData) =>
    new ElectrobunEvent<DetailData, {}>("download-started", data),
  downloadProgress: (data: DetailData) =>
    new ElectrobunEvent<DetailData, {}>("download-progress", data),
  downloadCompleted: (data: DetailData) =>
    new ElectrobunEvent<DetailData, {}>("download-completed", data),
  downloadFailed: (data: DetailData) =>
    new ElectrobunEvent<DetailData, {}>("download-failed", data),
};
