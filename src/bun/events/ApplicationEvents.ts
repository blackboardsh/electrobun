import ElectrobunEvent from "./event";

export default {
  applicationMenuClicked: (data) =>
    new ElectrobunEvent<{ id: number; action: string }, { allow: boolean }>(
      "application-menu-clicked",
      data
    ),
};
