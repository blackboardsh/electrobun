import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Optional test host. The default lifecycle remains a self-hosted flat folder.
 * Dash Cloud supplies this adapter from its own checkout, keeping the SDK test
 * independent of Cloud dependencies and credentials. */
export async function loadLifecycleHost(modulePath, context) {
	if (!modulePath) return null;
	const module = await import(pathToFileURL(resolve(modulePath)).href);
	assert.equal(typeof module.createLifecycleHost, "function", "lifecycle host must export createLifecycleHost");
	const host = await module.createLifecycleHost(context);
	try {
		assert.ok(host && typeof host === "object", "lifecycle host must return an object");
		const url = new URL(host.baseUrl);
		assert.ok(url.protocol === "http:" || url.protocol === "https:", "lifecycle host baseUrl must use HTTP(S)");
		assert.equal(typeof host.publishRelease, "function", "lifecycle host must implement publishRelease");
		assert.equal(typeof host.dispose, "function", "lifecycle host must implement dispose");
		for (const hook of ["afterInstall", "afterUpdate", "beforeUninstall", "afterUninstall"]) {
			assert.ok(host[hook] === undefined || typeof host[hook] === "function", `lifecycle host ${hook} must be a function`);
		}
		if (host.buildEnvironment !== undefined) {
			assert.ok(host.buildEnvironment && typeof host.buildEnvironment === "object" && !Array.isArray(host.buildEnvironment), "lifecycle host buildEnvironment must be an object");
			assert.ok(Object.values(host.buildEnvironment).every(value => typeof value === "string"), "lifecycle host buildEnvironment values must be strings");
		}
		return host;
	} catch (error) {
		if (typeof host?.dispose === "function") await host.dispose();
		throw error;
	}
}

/** The lifecycle verifies the profile identity, not installer-specific launches
 * that may have run before the test's isolated profile was selected. */
export function assertLifecycleInstallation(events, expectedId) {
	const scoped = events.filter(event => event.event === "installation-identity");
	assert.ok(scoped.length > 0, "installed app did not report its installation ID");
	const id = expectedId ?? scoped[0].details?.installationId;
	assert.match(id, /^[0-9a-f]{32}$/, "installed app must expose its persisted installation ID");
	for (const event of scoped) {
		assert.equal(event.details?.installationId, id, "updates must preserve the installed profile's installation ID");
		assert.equal(event.details?.insightsId, id, "managed updates and Insights must share the installation ID");
	}
	return id;
}
