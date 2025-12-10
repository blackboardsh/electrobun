import ElectrobunEvent from "./event";

export default {
  applicationMenuClicked: (data) =>
    new ElectrobunEvent<{ id: number; action: string }, { allow: boolean }>(
      "application-menu-clicked",
      data
    ),
  contextMenuClicked: (data) =>
    new ElectrobunEvent<{ id: number; action: string }, { allow: boolean }>(
      "context-menu-clicked",
      data
    ),
};
