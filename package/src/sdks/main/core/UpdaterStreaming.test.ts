import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getPlatformPrefix } from "../../../shared/naming";
import { ARCH, OS } from "../../../shared/platform";
import {
	Updater,
	createNativeUpdatePlan,
	prepareNativeUpdate,
	resolveInstalledChannelRootForPlatform,
	validatePreparedUpdate,
	validateUpdateManifest,
	withNativePreparationHelper,
	type LocalUpdateInfo,
	type NativePrepareUpdateRequest,
	type NativeUpdatePlanV2,
	type PreparedUpdateV2,
	type UpdateManifestV1,
} from "./Updater";

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const originalLocalInfo = Updater.getLocalInfo;

afterEach(() => {
	globalThis.fetch = originalFetch;
	Updater.getLocalInfo = originalLocalInfo;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const info: LocalUpdateInfo = {
	identifier: "com.example.streaming",
	channel: "stable",
	version: "1.0.0",
	hash: "old123",
	baseUrl: "https://updates.example.invalid/releases",
	name: "Example",
};
const transactionId = "0123456789abcdef0123456789abcdef";
const expected = { identifier: info.identifier, channel: info.channel, platform: OS, arch: ARCH };

function manifest(): UpdateManifestV1 {
	return {
		schemaVersion: 1,
		...expected,
		version: "2.0.0",
		hash: "new456",
		artifact: {
			file: `${getPlatformPrefix("stable", OS, ARCH)}-Example.tar.zst`,
			tarSha256: "a".repeat(64),
			tarSize: 4096,
		},
	};
}

function fixture() {
	const root = resolve(mkdtempSync(join(tmpdir(), "electrobun-streaming-sdk-")));
	roots.push(root);
	const channelRoot = join(root, info.identifier, info.channel);
	const appBundlePath = OS === "macos" ? join(root, "Example.app") : join(channelRoot, "app");
	const extraction = join(channelRoot, "self-extraction");
	mkdirSync(extraction, { recursive: true });
	const bundledHelper = OS === "macos"
		? join(appBundlePath, "Contents", "Resources", "uninstall")
		: join(appBundlePath, "Resources", "uninstall");
	mkdirSync(dirname(bundledHelper), { recursive: true });
	writeFileSync(bundledHelper, "current manager");
	writeFileSync(join(channelRoot, OS === "win" ? "uninstall.exe" : "uninstall"), "older manager");
	const staged: PreparedUpdateV2 = {
		schema_version: 2,
		...expected,
		version: manifest().version,
		hash: manifest().hash,
		staging_path: `${appBundlePath}.prepared-${manifest().hash}`,
		recipe_path: join(extraction, `${manifest().hash}.recipe.json`),
		recipe_sha256: "b".repeat(64),
		artifact_file: manifest().artifact.file,
	};
	const recordPath = join(extraction, ".electrobun-prepared-update.json");
	const requestPath = join(channelRoot, `.electrobun-prepare-${transactionId}.json`);
	return {
		root, channelRoot, appBundlePath, extraction, bundledHelper, staged, recordPath, requestPath,
		publish() {
			mkdirSync(staged.staging_path);
			writeFileSync(staged.recipe_path, "archive recipe");
			writeFileSync(recordPath, JSON.stringify(staged));
		},
		options: { info, manifest: manifest(), channelRoot, appBundlePath, transactionId },
	};
}

describe("native streamed update preparation", () => {
	test("hands exact archive integrity to the bundled helper and accepts a staged result without a tar", async () => {
		const f = fixture();
		let executedHelper = "";
		const prepared = await prepareNativeUpdate({
			...f.options,
			async execute(helper, args) {
				executedHelper = helper;
				if (OS === "win") {
					expect(helper).toEndWith(`electrobun-update-${transactionId}.exe`);
					expect(readFileSync(helper, "utf8")).toBe("current manager");
				} else {
					expect(helper).toBe(f.bundledHelper);
				}
				expect(args).toEqual(["--prepare-update", f.requestPath, "--quiet"]);
				const request = JSON.parse(readFileSync(f.requestPath, "utf8")) as NativePrepareUpdateRequest;
				expect(request.base_hash).toBe(info.hash);
				expect(request.hash).toBe(manifest().hash);
				expect(request.tar_sha256).toBe(manifest().artifact.tarSha256!);
				expect(request.tar_size).toBe(manifest().artifact.tarSize!);
				expect(request.app_bundle_path).toBe(f.appBundlePath);
				f.publish();
			},
		});
		expect(prepared).toEqual(f.staged);
		if (OS === "win") expect(existsSync(executedHelper)).toBe(false);
		expect(existsSync(f.requestPath)).toBe(false);
		expect(readdirSync(f.extraction).some((name) => name.endsWith(".tar"))).toBe(false);
		expect(readFileSync(f.bundledHelper, "utf8")).toBe("current manager");
	});

	test("Windows preparation executes the copied exe and waits for exit before cleanup", async () => {
		const events: string[] = [];
		let finish!: () => void;
		const exited = new Promise<void>((resolve) => { finish = resolve; });
		const operation = withNativePreparationHelper(
			"win", "C:\\app\\Resources\\uninstall",
			() => { events.push("copy"); return "C:\\Temp\\electrobun-update.exe"; },
			async (helper) => { events.push(`execute:${helper}`); await exited; events.push("exited"); },
			(helper) => { events.push(`remove:${helper}`); },
		);
		expect(events).toEqual(["copy", "execute:C:\\Temp\\electrobun-update.exe"]);
		finish();
		await operation;
		expect(events).toEqual(["copy", "execute:C:\\Temp\\electrobun-update.exe", "exited", "remove:C:\\Temp\\electrobun-update.exe"]);
	});

	test("Windows helper cleanup preserves successful preparation and the original execution error", async () => {
		let removals = 0;
		const remove = () => { removals++; throw new Error("scanner still holds executable"); };
		await withNativePreparationHelper("win", "uninstall", () => "helper.exe", async () => {}, remove);
		await expect(withNativePreparationHelper("win", "uninstall", () => "helper.exe", async () => {
			throw new Error("preparation failed");
		}, remove)).rejects.toThrow("preparation failed");
		expect(removals).toBe(2);
	});

	test("POSIX preparation uses its installed helper without copying or removing it", async () => {
		let executed = "";
		await withNativePreparationHelper("linux", "/app/Resources/uninstall",
			() => { throw new Error("unexpected copy"); },
			async (helper) => { executed = helper; },
			() => { throw new Error("unexpected cleanup"); },
		);
		expect(executed).toBe("/app/Resources/uninstall");
	});

	test("does not accept helper success without the requested staged release", async () => {
		const f = fixture();
		await expect(prepareNativeUpdate({
			...f.options,
			async execute() {
				f.publish();
				writeFileSync(f.recordPath, JSON.stringify({ ...f.staged, version: "99.0.0" }));
			},
		})).rejects.toThrow("did not publish the requested staged update");
		expect(existsSync(f.requestPath)).toBe(false);
	});

	test("propagates native preparation failure and cleans its request without touching the installed app", async () => {
		const f = fixture();
		await expect(prepareNativeUpdate({
			...f.options,
			async execute() { throw new Error("not enough staging space"); },
		})).rejects.toThrow("not enough staging space");
		expect(existsSync(f.requestPath)).toBe(false);
		expect(readFileSync(f.bundledHelper, "utf8")).toBe("current manager");
		expect(existsSync(f.recordPath)).toBe(false);
	});

	test("rejects unsafe and missing stage or recipe paths", () => {
		const f = fixture();
		f.publish();
		expect(validatePreparedUpdate(f.staged, info, f.channelRoot, f.appBundlePath)).toEqual(f.staged);
		for (const mutation of [
			{ staging_path: `${f.appBundlePath}.prepared-another` },
			{ staging_path: f.appBundlePath },
			{ recipe_path: join(f.root, "outside.recipe.json") },
			{ recipe_sha256: undefined },
			{ recipe_sha256: "B".repeat(64) },
			{ recipe_sha256: "not-a-digest" },
			{ hash: "../escape" },
		]) {
			expect(() => validatePreparedUpdate({ ...f.staged, ...mutation }, info, f.channelRoot, f.appBundlePath)).toThrow();
		}
		rmSync(f.staged.recipe_path);
		expect(() => validatePreparedUpdate(f.staged, info, f.channelRoot, f.appBundlePath)).toThrow();
	});

	if (OS !== "win") test("refuses symlinked recipe ancestors and staging directories", () => {
		const f = fixture();
		f.publish();
		rmSync(f.staged.staging_path, { recursive: true });
		symlinkSync(f.appBundlePath, f.staged.staging_path, "dir");
		expect(() => validatePreparedUpdate(f.staged, info, f.channelRoot, f.appBundlePath)).toThrow("staging directory");
		rmSync(f.staged.staging_path);
		mkdirSync(f.staged.staging_path);
		rmSync(f.extraction, { recursive: true });
		const outside = join(f.root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, `${manifest().hash}.recipe.json`), "recipe");
		symlinkSync(outside, f.extraction, "dir");
		expect(() => validatePreparedUpdate(f.staged, info, f.channelRoot, f.appBundlePath)).toThrow("paths");
	});

	test("binds a schema2 apply plan to exact stage, recipe and transaction paths", () => {
		const f = fixture();
		const plan: NativeUpdatePlanV2 = {
			schema_version: 2,
			...expected,
			transaction_id: transactionId,
			version: manifest().version,
			hash: manifest().hash,
			channel_root: f.channelRoot,
			app_bundle_path: f.appBundlePath,
			retained_tar_path: "",
			staging_path: f.staged.staging_path,
			recipe_path: f.staged.recipe_path,
			recipe_sha256: f.staged.recipe_sha256,
			parent_pid: 1234,
			result_path: join(f.channelRoot, `.electrobun-update-${transactionId}.result.json`),
		};
		expect(createNativeUpdatePlan(plan)).toEqual(plan);
		expect(createNativeUpdatePlan(plan).recipe_sha256).toBe(f.staged.recipe_sha256);
		for (const mutation of [
			{ staging_path: f.appBundlePath },
			{ recipe_path: join(f.extraction, "other.recipe.json") },
			{ result_path: join(f.channelRoot, "unrelated.json") },
		]) expect(() => createNativeUpdatePlan({ ...plan, ...mutation })).toThrow("paths");
		for (const recipeSha256 of [undefined, "", "B".repeat(64), "b".repeat(63)]) {
			expect(() => createNativeUpdatePlan({ ...plan, recipe_sha256: recipeSha256 } as NativeUpdatePlanV2)).toThrow("paths");
		}
	});

	test("resolves a legacy macOS channel from the recipe after its retained tar is gone", () => {
		const legacy = "/Users/example/Library/Application Support/com.example.streaming/Example";
		expect(resolveInstalledChannelRootForPlatform(
			info, "macos", "/Applications/Example.app/Contents/MacOS/bun",
			"/Users/example/Library/Application Support",
			(path) => path === `${legacy}/self-extraction/${info.hash}.recipe.json`,
		)).toBe(legacy);
	});
});

describe("archive integrity metadata compatibility", () => {
	test("accepts both legacy metadata and a complete archive integrity pair", () => {
		expect(validateUpdateManifest(manifest(), expected).artifact).toEqual(manifest().artifact);
		const legacy = { ...manifest(), artifact: { file: manifest().artifact.file } };
		expect(validateUpdateManifest(legacy, expected).artifact).toEqual(legacy.artifact);
	});

	test("rejects partial, malformed or unsafe archive integrity values", () => {
		for (const metadata of [
			{ tarSha256: "a".repeat(64) },
			{ tarSize: 4096 },
			{ tarSha256: "A".repeat(64), tarSize: 4096 },
			{ tarSha256: "a".repeat(64), tarSize: 0 },
			{ tarSha256: "a".repeat(64), tarSize: Number.MAX_SAFE_INTEGER + 1 },
		]) {
			expect(() => validateUpdateManifest({ ...manifest(), artifact: { file: manifest().artifact.file, ...metadata } }, expected)).toThrow("integrity");
		}
	});

	test("uses legacy metadata only when the integrity document returns 404", async () => {
		Updater.getLocalInfo = async () => info;
		const urls: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request) => {
			urls.push(String(url));
			if (urls.length === 1) return new Response(null, { status: 404 });
			return Response.json({ ...manifest(), artifact: { file: manifest().artifact.file } });
		}) as unknown as typeof fetch;
		expect((await Updater.checkForUpdate()).error).toBe("");
		expect(urls).toHaveLength(2);
		expect(urls[0]).toContain("-update-v2.json?");
		expect(urls[1]).toContain("-update.json?");
	});

	for (const response of [
		() => new Response(null, { status: 403 }),
		() => Response.json({ ...manifest(), artifact: { file: manifest().artifact.file } }),
		() => Response.json({ ...manifest(), artifact: { file: manifest().artifact.file, tarSize: 4096 } }),
	]) test("does not downgrade a forbidden or malformed integrity manifest", async () => {
		Updater.getLocalInfo = async () => info;
		let requests = 0;
		globalThis.fetch = (async () => { requests++; return response(); }) as unknown as typeof fetch;
		expect((await Updater.checkForUpdate()).error).not.toBe("");
		expect(requests).toBe(1);
	});
});
