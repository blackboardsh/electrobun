/** Shared local identity settings. Loading identity does not start Insights. */
export type InstallationConfig = { appId?: string; storagePath: string };

type InstallationBundle = {
	insights?: { appId?: unknown; enabled?: unknown };
	managed?: { appId?: unknown };
};

export function validateInstallationConfig(config: InstallationConfig): InstallationConfig {
	if ((config.appId !== undefined && (typeof config.appId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(config.appId)))
		|| typeof config.storagePath !== "string" || !config.storagePath || config.storagePath.includes("\0")) {
		throw new Error("Invalid installation identity configuration");
	}
	return { ...(config.appId === undefined ? {} : { appId: config.appId }), storagePath: config.storagePath };
}

export function resolveInstallationConfiguration(
	build: InstallationBundle,
	version: InstallationBundle,
	storagePath: string,
): InstallationConfig {
	const appIds = [build.insights?.appId, version.managed?.appId, build.managed?.appId]
		.filter((id) => id !== undefined);
	if (appIds.some((id) => id !== appIds[0])) {
		throw new Error("Managed updates and Insights must use the same app ID");
	}
	return validateInstallationConfig({ appId: appIds[0] as string | undefined, storagePath });
}

/** Keep identity setup lazy, so importing the SDK does not create local state. */
export function createInstallationClient(dependencies: {
	loadConfiguration(): InstallationConfig | null;
	configure(json: string): boolean;
	getId(): string | null;
}) {
	let configured = false;
	function configure(config: InstallationConfig): boolean {
		try {
			configured = dependencies.configure(JSON.stringify(validateInstallationConfig(config)));
			return configured;
		} catch { return false; }
	}
	return {
		configure,
		getId(): string | null {
			try {
				if (!configured) {
					const config = dependencies.loadConfiguration();
					if (config && !configure(config)) return null;
				}
				const id = dependencies.getId();
				return id && /^[a-f0-9]{32}$/.test(id) ? id : null;
			} catch { return null; }
		},
	};
}
