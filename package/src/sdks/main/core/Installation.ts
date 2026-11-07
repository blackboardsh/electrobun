import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BuildConfig } from "./BuildConfig";
import { RESOURCES_FOLDER } from "./Paths";
import { paths } from "./Utils";
import { installationNative } from "../proc/installationNative";
import { createInstallationClient, resolveInstallationConfiguration, type InstallationConfig } from "./InstallationConfig";

const client = createInstallationClient({
	loadConfiguration() {
		const build = BuildConfig.getSync();
		let version: { managed?: { appId?: unknown } } = {};
		try { version = JSON.parse(readFileSync(join(RESOURCES_FOLDER, "version.json"), "utf8")); } catch {}
		// This is the existing identity location; keep it so installed apps retain their IDs.
		return resolveInstallationConfiguration(build, version, join(paths.userData, "insights"));
	},
	configure: installationNative.configure,
	getId: installationNative.getInstallationId,
});

/** Internal shared identity client. Public applications use app.getInstallationId(). */
export const Installation = {
	/** Return the app's persisted install ID without enabling analytics or making a request.
	 * Suitable for a copyable value in the application's About, Help, or settings UI.
	 * Returns null if local identity storage or the native core is unavailable.
	 */
	getId: client.getId,
	/** Optional explicit setup for apps that do not use bundled managed-service settings. */
	configure(config: { appId?: string; storagePath?: string }): boolean {
		try {
			return client.configure({ ...config, storagePath: config.storagePath ?? join(paths.userData, "insights") });
		} catch { return false; }
	},
};

export type { InstallationConfig };
