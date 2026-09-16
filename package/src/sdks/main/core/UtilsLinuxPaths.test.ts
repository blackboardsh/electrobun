import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const temporaryDirectories: string[] = [];

type LinuxPathsResult = {
	appData: string;
	cache: string;
	logs: string;
	userData: string;
	userCache: string;
	userLogs: string;
};

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function readLinuxPaths(overrides: Record<string, string>) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "electrobun-linux-paths-"));
	temporaryDirectories.push(fixtureRoot);
	const runtimeDirectory = join(fixtureRoot, "runtime");
	const resourcesDirectory = join(fixtureRoot, "Resources");
	mkdirSync(runtimeDirectory);
	mkdirSync(resourcesDirectory);
	writeFileSync(
		join(resourcesDirectory, "version.json"),
		JSON.stringify({ identifier: "com.example.paths", channel: "canary" }),
	);

	const utilsUrl = pathToFileURL(join(import.meta.dirname, "Utils.ts")).href;
	const script = `
		const { paths } = await import(${JSON.stringify(utilsUrl)});
		console.log(JSON.stringify({
			appData: paths.appData,
			cache: paths.cache,
			logs: paths.logs,
			userData: paths.userData,
			userCache: paths.userCache,
			userLogs: paths.userLogs,
		}));
	`;
	const result = spawnSync(process.execPath, ["--eval", script], {
		cwd: runtimeDirectory,
		encoding: "utf8",
		env: { ...process.env, ...overrides },
	});
	expect(result.error).toBeUndefined();
	expect(result.status).toBe(0);
	return JSON.parse(result.stdout.trim()) as LinuxPathsResult;
}

describe.skipIf(process.platform !== "linux")("Utils Linux XDG paths", () => {
	test("uses nonempty absolute XDG roots", () => {
		const home = "/tmp/electrobun paths home";
		const data = "/tmp/electrobun xdg/data";
		const cache = "/tmp/electrobun xdg/cache";
		const state = "/tmp/electrobun xdg/state";
		const paths = readLinuxPaths({
			HOME: home,
			XDG_DATA_HOME: data,
			XDG_CACHE_HOME: cache,
			XDG_STATE_HOME: state,
		});

		expect(paths.appData).toBe(data);
		expect(paths.cache).toBe(cache);
		expect(paths.logs).toBe(state);
		expect(paths.userData).toBe(join(data, "com.example.paths", "canary"));
		expect(paths.userCache).toBe(
			join(cache, "com.example.paths", "canary"),
		);
		expect(paths.userLogs).toBe(join(state, "com.example.paths", "canary"));
	});

	test("normalizes absolute XDG roots with trailing and dot segments", () => {
		const home = "/tmp/electrobun normalized home";
		const base = "/tmp/electrobun normalized xdg";
		const paths = readLinuxPaths({
			HOME: home,
			XDG_DATA_HOME: `${base}/data/`,
			XDG_CACHE_HOME: `${base}/cache/./`,
			XDG_STATE_HOME: `${base}/nested/../state`,
		});

		expect(paths.appData).toBe(join(base, "data"));
		expect(paths.cache).toBe(join(base, "cache"));
		expect(paths.logs).toBe(join(base, "state"));
		expect(paths.userData).toBe(
			join(base, "data", "com.example.paths", "canary"),
		);
		expect(paths.userCache).toBe(
			join(base, "cache", "com.example.paths", "canary"),
		);
		expect(paths.userLogs).toBe(
			join(base, "state", "com.example.paths", "canary"),
		);
	});

	test("falls back for empty XDG roots", () => {
		const home = "/tmp/electrobun fallback home";
		const paths = readLinuxPaths({
			HOME: home,
			XDG_DATA_HOME: "",
			XDG_CACHE_HOME: "",
			XDG_STATE_HOME: "",
		});

		expect(paths.appData).toBe(join(home, ".local", "share"));
		expect(paths.cache).toBe(join(home, ".cache"));
		expect(paths.logs).toBe(join(home, ".local", "state"));
		expect(paths.userData).toBe(
			join(home, ".local", "share", "com.example.paths", "canary"),
		);
		expect(paths.userCache).toBe(
			join(home, ".cache", "com.example.paths", "canary"),
		);
		expect(paths.userLogs).toBe(
			join(home, ".local", "state", "com.example.paths", "canary"),
		);
	});

	test("falls back for relative or filesystem-root XDG values", () => {
		const home = "/tmp/electrobun relative fallback";
		const paths = readLinuxPaths({
			HOME: home,
			XDG_DATA_HOME: "relative/data",
			XDG_CACHE_HOME: "/",
			XDG_STATE_HOME: "../state-override",
		});

		expect(paths.appData).toBe(join(home, ".local", "share"));
		expect(paths.cache).toBe(join(home, ".cache"));
		expect(paths.logs).toBe(join(home, ".local", "state"));
		expect(paths.userData).toBe(
			join(home, ".local", "share", "com.example.paths", "canary"),
		);
		expect(paths.userCache).toBe(
			join(home, ".cache", "com.example.paths", "canary"),
		);
		expect(paths.userLogs).toBe(
			join(home, ".local", "state", "com.example.paths", "canary"),
		);
	});
});
