import { createUpdaterClient } from "./UpdaterClient";
import type { QuitApproval } from "./Utils";
import { registerUpdaterShutdown, updaterConfiguration, updaterNative } from "../proc/updaterNative";

export type { LocalUpdateInfo, UpdateInfo, UpdateStatusDetails, UpdateStatusEntry, UpdateStatusType } from "./UpdaterTypes";

const client = createUpdaterClient<QuitApproval>({
	native: updaterNative,
	configuration: updaterConfiguration,
	// Load the application event/quit bridge only for an approved native apply
	// request. Standalone updater imports remain safe in build tools and tests.
	requestQuitApproval: () => (require("./Utils") as typeof import("./Utils")).requestQuitApproval(),
	cancelQuitApproval: (approval) => (require("./Utils") as typeof import("./Utils")).cancelQuitApproval(approval),
	quitAfterApproval: (approval, code) => (require("./Utils") as typeof import("./Utils")).quitAfterApproval(approval, code),
});

registerUpdaterShutdown(client.shutdown);

export const Updater = client.updater;
