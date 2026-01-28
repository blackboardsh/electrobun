import ElectrobunEvent from "./event";

type TrayClickedData = { id: number; action: string; data?: unknown };

export default {
  trayClicked: (data: TrayClickedData) =>
    new ElectrobunEvent<TrayClickedData, { allow: boolean }>(
      "tray-clicked",
      data
    ),
};
