import ElectrobunEvent from "./event";

type MenuClickedData = { id?: number; action: string; data?: unknown };
type OpenUrlData = { url: string };
type NotificationClickedData = { userInfo: Record<string, unknown> };

export default {
	applicationMenuClicked: (data: MenuClickedData) =>
		new ElectrobunEvent<MenuClickedData, { allow: boolean }>(
			"application-menu-clicked",
			data,
		),
	contextMenuClicked: (data: MenuClickedData) =>
		new ElectrobunEvent<MenuClickedData, { allow: boolean }>(
			"context-menu-clicked",
			data,
		),
	openUrl: (data: OpenUrlData) =>
		new ElectrobunEvent<OpenUrlData, void>("open-url", data),
	notificationClicked: (data: NotificationClickedData) =>
		new ElectrobunEvent<NotificationClickedData, void>(
			"notification-clicked",
			data,
		),
	reopen: (data: {}) => new ElectrobunEvent<{}, void>("reopen", data),
	beforeQuit: (data: {}) =>
		new ElectrobunEvent<{}, { allow: boolean }>("before-quit", data),
};
