import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Updater, Utils, type UpdateStatusEntry } from "electrobun/bun";
import { control } from "../control";

type FixtureEvent = {
	time: string;
	pid: number;
	event: string;
	version?: string;
	details?: unknown;
};

const normalizePath = (path: string) => {
	const normalized = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const appendEvent = (event: string, version?: string, details?: unknown) => {
	mkdirSync(control.signalDirectory, { recursive: true });
	const entry: FixtureEvent = {
		time: new Date().toISOString(),
		pid: process.pid,
		event,
		version,
		details,
	};
	appendFileSync(control.eventLogPath, `${JSON.stringify(entry)}\n`, "utf8");
};

const writeJsonAtomically = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true });
	const partial = `${path}.${process.pid}.partial`;
	writeFileSync(partial, `${JSON.stringify(value)}\n`, "utf8");
	renameSync(partial, path);
};

const fail = (error: unknown, version?: string) => {
	const message = error instanceof Error ? error.stack || error.message : String(error);
	appendEvent("failed", version, { message });
	writeJsonAtomically(control.failurePath, {
		runToken: control.runToken,
		version,
		message,
	});
	Utils.quit(1);
};

let resolveReconciledComplete: ((entry: UpdateStatusEntry) => void) | undefined;
let runningVersion = control.builtVersion;
const reconciledComplete = new Promise<UpdateStatusEntry>((resolvePromise) => {
	resolveReconciledComplete = resolvePromise;
});

const recordStatus = (entry: UpdateStatusEntry) => {
	appendEvent("updater-status", runningVersion, entry);
	if (entry.status === "complete") resolveReconciledComplete?.(entry);
};

const waitForReconciledComplete = async (): Promise<UpdateStatusEntry> => {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			reconciledComplete,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error("timed out waiting for reconciled update result")),
					15_000,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
};

const run = async () => {
	Updater.onStatusChange(recordStatus);
	const localInfo = await Updater.getLocalInfo();
	if (localInfo.version !== control.builtVersion) {
		throw new Error(
			`packaged fixture version mismatch: ${JSON.stringify({ local: localInfo.version, built: control.builtVersion })}`,
		);
	}
	runningVersion = localInfo.version;
	appendEvent("launched", localInfo.version, {
		hash: localInfo.hash,
		channel: localInfo.channel,
		identifier: localInfo.identifier,
		baseUrl: localInfo.baseUrl,
	});

	if (
		localInfo.identifier !== control.identifier ||
		localInfo.channel !== control.channel
	) {
		throw new Error(
			`unexpected installed identity ${localInfo.identifier}/${localInfo.channel}`,
		);
	}
	const releaseSequence = [
		control.initialVersion,
		control.intermediateVersion,
		control.patchTargetVersion,
		control.fallbackTargetVersion,
	];
	if (!releaseSequence.includes(localInfo.version)) {
		throw new Error(
			`packaged version ${localInfo.version} is outside the fixture lifecycle`,
		);
	}

	const appDataFolder = await Updater.appDataFolder();
	const runningAppBundlePath =
		process.platform === "darwin"
			? resolve(dirname(process.execPath), "..", "..")
			: resolve(dirname(process.execPath), "..");
	const scopedLaunch =
		normalizePath(appDataFolder) === normalizePath(control.channelRoot) &&
		normalizePath(runningAppBundlePath) ===
			normalizePath(control.appBundlePath);
	// Setup may relaunch v1 as part of installation. The harness activates the
	// updater only after it has prepared the v1-compatible stable scope.
	if (!existsSync(control.updateActivationPath)) {
		appendEvent("ignored-installer-relaunch", localInfo.version, {
			appDataFolder,
			runningAppBundlePath,
			expectedChannelRoot: control.channelRoot,
			expectedAppBundlePath: control.appBundlePath,
		});
		Utils.quit(0);
		return;
	}
	const activation = JSON.parse(
		readFileSync(control.updateActivationPath, "utf8"),
	) as { runToken?: unknown; targetVersion?: unknown };
	if (
		activation.runToken !== control.runToken ||
		typeof activation.targetVersion !== "string" ||
		!releaseSequence.includes(activation.targetVersion)
	) {
		throw new Error(`invalid update activation: ${JSON.stringify(activation)}`);
	}
	if (!scopedLaunch) {
		throw new Error(
			`running install scope did not resolve to the migrated physical root: ${JSON.stringify({ appDataFolder, runningAppBundlePath, expectedChannelRoot: control.channelRoot, expectedAppBundlePath: control.appBundlePath })}`,
		);
	}
	const standaloneManagerPath = join(
		control.channelRoot,
		process.platform === "win32" ? "uninstall.exe" : "uninstall",
	);
	const uninstallManifestPath = join(
		control.channelRoot,
		".electrobun-uninstall.json",
	);
	if (
		!existsSync(standaloneManagerPath) ||
		!existsSync(uninstallManifestPath)
	) {
		throw new Error(
			`launcher did not bootstrap v2 install integration: ${JSON.stringify({ standaloneManagerPath, uninstallManifestPath })}`,
		);
	}

	const installedRootName = basename(control.channelRoot);
	if (process.env["ELECTROBUN_INSTALL_ROOT_NAME"] !== installedRootName) {
		throw new Error(
			`launcher did not publish the physical install root: ${JSON.stringify({ actual: process.env["ELECTROBUN_INSTALL_ROOT_NAME"], expected: installedRootName })}`,
		);
	}
	const userDataSentinelPath = join(
		Utils.paths.userData,
		"updater-lifecycle-user-data.json",
	);
	const browserProfileSentinelPath = join(
		control.browserProfileRoot,
		"updater-lifecycle-profile.json",
	);
	if (
		normalizePath(Utils.paths.userData) !== normalizePath(control.channelRoot) ||
		basename(Utils.paths.userCache) !== installedRootName ||
		basename(Utils.paths.userLogs) !== installedRootName
	) {
		throw new Error(
			`app-scoped paths did not preserve the physical install root: ${JSON.stringify({ userData: Utils.paths.userData, userCache: Utils.paths.userCache, userLogs: Utils.paths.userLogs, expectedUserData: control.channelRoot, expectedRootName: installedRootName })}`,
		);
	}

	if (existsSync(control.bootstrapVerificationPath)) {
		if (localInfo.version !== control.patchTargetVersion) {
			throw new Error(
				`bootstrap repair must run on ${control.patchTargetVersion}, not ${localInfo.version}`,
			);
		}
		appendEvent("target-bootstrap-repaired", localInfo.version, {
			standaloneManagerPath,
			uninstallManifestPath,
		});
		Utils.quit(0);
		return;
	}

	const currentIndex = releaseSequence.indexOf(localInfo.version);
	const targetIndex = releaseSequence.indexOf(activation.targetVersion);
	if (localInfo.version === activation.targetVersion) {
		const preservedUserData = JSON.parse(
			readFileSync(userDataSentinelPath, "utf8"),
		);
		const preservedBrowserProfile = JSON.parse(
			readFileSync(browserProfileSentinelPath, "utf8"),
		);
		const expectedVisits =
			localInfo.version === control.patchTargetVersion
				? []
				: [control.patchTargetVersion];
		if (
			preservedUserData.runToken !== control.runToken ||
			preservedUserData.value !== "preserved-across-update" ||
			JSON.stringify(preservedUserData.visitedVersions) !==
				JSON.stringify(expectedVisits)
		) {
			throw new Error(
				`user data did not preserve the expected update chain: ${JSON.stringify({ preservedUserData, expectedVisits })}`,
			);
		}
		if (
			preservedBrowserProfile.runToken !== control.runToken ||
			preservedBrowserProfile.value !== "profile-preserved-across-update"
		) {
			throw new Error(
				`v1 browser profile was not preserved: ${JSON.stringify(preservedBrowserProfile)}`,
			);
		}
		appendEvent("user-data-preserved", localInfo.version, {
			userData: Utils.paths.userData,
			userCache: Utils.paths.userCache,
			userLogs: Utils.paths.userLogs,
			browserProfileRoot: control.browserProfileRoot,
		});
		writeJsonAtomically(userDataSentinelPath, {
			...preservedUserData,
			visitedVersions: [...expectedVisits, localInfo.version],
		});
		const reconciledStatus = await waitForReconciledComplete();
		appendEvent("update-result-reconciled", localInfo.version, reconciledStatus);
		const relaunchSentinelPath =
			localInfo.version === control.patchTargetVersion
				? control.patchRelaunchSentinelPath
				: control.fallbackRelaunchSentinelPath;
		writeJsonAtomically(relaunchSentinelPath, {
			runToken: control.runToken,
			pid: process.pid,
			version: localInfo.version,
			hash: localInfo.hash,
			identifier: localInfo.identifier,
			channel: localInfo.channel,
		});
		appendEvent("target-relaunched", localInfo.version, {
			hash: localInfo.hash,
		});
		Utils.quit(0);
		return;
	}

	const supportedTransition =
		(localInfo.version === control.initialVersion &&
			activation.targetVersion === control.patchTargetVersion &&
			targetIndex === currentIndex + 2) ||
		(localInfo.version === control.patchTargetVersion &&
			activation.targetVersion === control.fallbackTargetVersion &&
			targetIndex === currentIndex + 1);
	if (!supportedTransition) {
		throw new Error(
			`unsupported fixture update transition ${localInfo.version} -> ${activation.targetVersion}`,
		);
	}
	if (localInfo.version === control.initialVersion) {
		appendEvent("integration-bootstrapped", localInfo.version, {
			standaloneManagerPath,
			uninstallManifestPath,
		});
		mkdirSync(Utils.paths.userData, { recursive: true });
		mkdirSync(control.browserProfileRoot, { recursive: true });
		writeJsonAtomically(userDataSentinelPath, {
			runToken: control.runToken,
			value: "preserved-across-update",
			visitedVersions: [],
		});
		writeJsonAtomically(browserProfileSentinelPath, {
			runToken: control.runToken,
			value: "profile-preserved-across-update",
		});
		appendEvent("user-data-seeded", localInfo.version, {
			userData: Utils.paths.userData,
			userCache: Utils.paths.userCache,
			userLogs: Utils.paths.userLogs,
			browserProfileRoot: control.browserProfileRoot,
		});
	} else {
		const preservedUserData = JSON.parse(
			readFileSync(userDataSentinelPath, "utf8"),
		);
		const preservedBrowserProfile = JSON.parse(
			readFileSync(browserProfileSentinelPath, "utf8"),
		);
		if (
			preservedUserData.runToken !== control.runToken ||
			JSON.stringify(preservedUserData.visitedVersions) !==
				JSON.stringify([control.patchTargetVersion]) ||
			preservedBrowserProfile.runToken !== control.runToken
		) {
			throw new Error(
				`intermediate release state was not preserved: ${JSON.stringify({ preservedUserData, preservedBrowserProfile })}`,
			);
		}
		appendEvent("source-data-preserved", localInfo.version, {
			userData: Utils.paths.userData,
			browserProfileRoot: control.browserProfileRoot,
		});
	}

	const available = await Updater.checkForUpdate();
	if (available.error) throw new Error(available.error);
	if (
		!available.updateAvailable ||
		available.version !== activation.targetVersion
	) {
		throw new Error(
			`expected ${activation.targetVersion} update, received ${JSON.stringify(available)}`,
		);
	}

	appendEvent("download-started", localInfo.version, {
		targetHash: available.hash,
	});
	await Updater.downloadUpdate();
	const prepared = Updater.updateInfo();
	if (!prepared?.updateReady || prepared.error) {
		throw new Error(`update was not prepared: ${JSON.stringify(prepared)}`);
	}
	appendEvent("download-completed", localInfo.version, prepared);

	await Updater.applyUpdate();
	appendEvent("apply-returned", localInfo.version);
};

run().catch((error) => fail(error));
