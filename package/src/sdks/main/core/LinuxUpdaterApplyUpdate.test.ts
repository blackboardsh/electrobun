import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater } from "./Updater";

describe.skipIf(process.platform !== "linux")(
	"Linux updater uninstall metadata refresh wiring",
	() => {
		test("refreshes after replacing the app and before extraction cleanup", async () => {
			const temporaryRoot = mkdtempSync(
				join(tmpdir(), "electrobun-linux-updater-"),
			);
			const originalXdgDataHome = process.env["XDG_DATA_HOME"];
			const identifier = "com.example.updater-wiring";
			const channel = "production";
			const latestHash = "new-version-hash";
			const dataHome = join(temporaryRoot, "xdg data");
			const channelRoot = join(dataHome, identifier, channel);
			const extractionFolder = join(channelRoot, "self-extraction");
			const runningApp = join(channelRoot, "app");
			const payloadRoot = join(temporaryRoot, "payload");
			const newApp = join(payloadRoot, "NewApp");
			const latestTar = join(extractionFolder, `${latestHash}.tar`);
			const staleExtractionState = join(extractionFolder, "stale.patch");
			const refreshLog = join(channelRoot, "refresh.log");
			const oldManagerLog = join(channelRoot, "old-manager.log");

			mkdirSync(join(runningApp, "Resources"), { recursive: true });
			mkdirSync(join(newApp, "bin"), { recursive: true });
			mkdirSync(join(newApp, "Resources"), { recursive: true });
			mkdirSync(extractionFolder, { recursive: true });
			writeFileSync(join(runningApp, "old-version.txt"), "old\n");
			writeFileSync(join(newApp, "new-version.txt"), "new\n");
			writeFileSync(
				join(newApp, "bin", "launcher"),
				"#!/bin/sh\nexit 0\n",
			);
			writeFileSync(join(newApp, "bin", "cottontail"), "#!/bin/sh\nexit 0\n");
			writeFileSync(
				join(newApp, "Resources", "version.json"),
				JSON.stringify({
					channel,
					identifier,
					name: "Updater Wiring App",
					version: "2.0.0",
				}),
			);
			writeFileSync(staleExtractionState, "remove after refresh\n");
			const uninstaller = join(channelRoot, "uninstall");
			writeFileSync(
				uninstaller,
				`#!/bin/sh\nprintf 'old manager ran\\n' > "${oldManagerLog}"\nexit 99\n`,
			);
			chmodSync(uninstaller, 0o755);
			writeFileSync(join(channelRoot, ".electrobun-uninstall.json"), "{}\n");
			const packagedUninstaller = join(newApp, "Resources", "uninstall");
			writeFileSync(
				packagedUninstaller,
				[
					"#!/bin/sh",
					'test "$1" = "--refresh-metadata" || exit 41',
					'test "$2" = "--quiet" || exit 42',
					'test "$#" -eq 2 || exit 43',
					`test -f "${join(channelRoot, "app", "new-version.txt")}" || exit 44`,
					`test -f "${staleExtractionState}" || exit 45`,
					`printf 'refreshed\\n' > "${refreshLog}"`,
					"",
				].join("\n"),
			);
			chmodSync(packagedUninstaller, 0o755);

			const tarResult = spawnSync(
				"tar",
				["-cf", latestTar, "-C", payloadRoot, "NewApp"],
				{ encoding: "utf8" },
			);
			expect(tarResult.status).toBe(0);

			const updateDocument = {
				error: "",
				hash: latestHash,
				updateAvailable: true,
				updateReady: true,
				version: "2.0.0",
			};
			const localInfo = {
				baseUrl: "https://updates.invalid",
				channel,
				hash: "old-version-hash",
				identifier,
				name: "UpdaterWiringApp",
				version: "1.0.0",
			};
			const originalBunFile = Bun.file;
			const bunFileSpy = spyOn(Bun, "file").mockImplementation(
				((path: string | URL, options?: BlobPropertyBag) => {
					if (String(path) === "../Resources/version.json") {
						return {
							json: async () => localInfo,
						} as Bun.BunFile;
					}
					return originalBunFile(path, options);
				}) as typeof Bun.file,
			);
			const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
				(async () =>
					new Response(JSON.stringify(updateDocument), {
						status: 200,
					})) as unknown as typeof fetch,
			);
			const exitSpy = spyOn(process, "exit").mockImplementation(
				(() => undefined) as never,
			);

			try {
				process.env["XDG_DATA_HOME"] = dataHome;
				Updater.clearStatusHistory();
				await Updater.checkForUpdate();
				await Updater.applyUpdate();

				expect(readFileSync(refreshLog, "utf8")).toBe("refreshed\n");
				expect(existsSync(oldManagerLog)).toBe(false);
				expect(existsSync(join(runningApp, "new-version.txt"))).toBe(true);
				expect(existsSync(join(runningApp, "old-version.txt"))).toBe(false);
				expect(readFileSync(uninstaller, "utf8")).toBe(
					readFileSync(join(runningApp, "Resources", "uninstall"), "utf8"),
				);
				expect(lstatSync(uninstaller).mode & 0o777).toBe(0o755);
				expect(existsSync(staleExtractionState)).toBe(false);
				expect(existsSync(latestTar)).toBe(true);
				expect(fetchSpy).toHaveBeenCalledTimes(2);
				expect(exitSpy).toHaveBeenCalledTimes(1);
			} finally {
				if (originalXdgDataHome === undefined) {
					delete process.env["XDG_DATA_HOME"];
				} else {
					process.env["XDG_DATA_HOME"] = originalXdgDataHome;
				}
				bunFileSpy.mockRestore();
				fetchSpy.mockRestore();
				exitSpy.mockRestore();
				rmSync(temporaryRoot, { force: true, recursive: true });
			}
		});
	},
);
