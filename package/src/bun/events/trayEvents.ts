import ElectrobunEvent from "./event";

export default {
  trayClicked: (data) =>
    new ElectrobunEvent<{ id: number; action: string }, { allow: boolean }>(
      "tray-clicked",
      data,
    ),
};
