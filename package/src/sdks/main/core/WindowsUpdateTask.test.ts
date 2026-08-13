import { describe, expect, test } from "bun:test";
import {
	createWindowsUpdateTaskPlan,
	executeWindowsUpdateTaskPlan,
} from "./WindowsUpdateTask";
import type { WindowsUpdateTaskCommand } from "./WindowsUpdateTask";
import {
	createWindowsRegistrationRefreshBatch,
	createWindowsUpdateBatch,
	createWindowsUpdateTaskName,
	refreshLinuxUninstallerMetadata,
} from "./Updater";

const productionTaskName = "ElectrobunUpdate_e765e7a8ffa45d1ada904e46";

describe("Windows updater scheduled task", () => {
	test("runs on battery and cleans up the exact task", () => {
		const plan = createWindowsUpdateTaskPlan(
			productionTaskName,
			"C:\\Users\\Test User\\AppData\\Local\\Example\\update.bat",
		);

		expect(plan.create).toEqual({
			executable: "schtasks.exe",
			args: [
				"/create",
				"/tn",
				productionTaskName,
				"/tr",
				'cmd.exe /d /s /c ""C:\\Users\\Test User\\AppData\\Local\\Example\\update.bat""',
				"/sc",
				"once",
				"/st",
				"00:00",
				"/f",
			],
		});
		expect(plan.configure.executable).toBe("powershell.exe");
		expect(plan.configure.args.at(-1)).toContain(
			"-AllowStartIfOnBatteries",
		);
		expect(plan.configure.args.at(-1)).toContain(
			"-DontStopIfGoingOnBatteries",
		);
		expect(plan.configure.args.at(-1)).toContain(
			"$ErrorActionPreference = 'Stop'",
		);
		expect(plan.run.args).toEqual([
			"/run",
			"/tn",
			productionTaskName,
		]);
		expect(plan.deleteTask).toEqual({
			executable: "schtasks.exe",
			args: [
				"/delete",
				"/tn",
				productionTaskName,
				"/f",
			],
		});
		expect(plan.cleanupBatchLine).toBe(
			`schtasks.exe /delete /tn "${productionTaskName}" /f >nul 2>&1`,
		);
		expect(plan.cleanupBatchLine).not.toContain("/query");
	});

	test("rejects values that could escape the generated commands", () => {
		expect(() =>
			createWindowsUpdateTaskPlan(
				'ElectrobunUpdate_1" /delete /tn Important',
				"C:\\update.bat",
			),
		).toThrow("Invalid Electrobun update task name");
		expect(() =>
			createWindowsUpdateTaskPlan(
				productionTaskName,
				'C:\\bad"path\\update.bat',
			),
		).toThrow("Invalid Windows update script path");
	});

	test("deletes a created task before propagating a configure failure", () => {
		const plan = createWindowsUpdateTaskPlan(
			productionTaskName,
			"C:\\update.bat",
		);
		const configureError = new Error("configure failed");
		const commands: WindowsUpdateTaskCommand[] = [];
		let thrown: unknown;

		try {
			executeWindowsUpdateTaskPlan(plan, (command) => {
				commands.push(command);
				if (command === plan.configure) throw configureError;
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(configureError);
		expect(commands).toEqual([
			plan.create,
			plan.configure,
			plan.deleteTask,
		]);
	});

	test("deletes a created task before propagating a run failure", () => {
		const plan = createWindowsUpdateTaskPlan(
			productionTaskName,
			"C:\\update.bat",
		);
		const runError = new Error("run failed");
		const commands: WindowsUpdateTaskCommand[] = [];
		let thrown: unknown;

		try {
			executeWindowsUpdateTaskPlan(plan, (command) => {
				commands.push(command);
				if (command === plan.run) throw runError;
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(runError);
		expect(commands).toEqual([
			plan.create,
			plan.configure,
			plan.run,
			plan.deleteTask,
		]);
	});

	test("does not delete when task creation itself fails", () => {
		const plan = createWindowsUpdateTaskPlan(
			productionTaskName,
			"C:\\update.bat",
		);
		const createError = new Error("create failed");
		const commands: WindowsUpdateTaskCommand[] = [];
		let thrown: unknown;

		try {
			executeWindowsUpdateTaskPlan(plan, (command) => {
				commands.push(command);
				throw createError;
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(createError);
		expect(commands).toEqual([plan.create]);
	});

	test("reports both the task and cleanup failures", () => {
		const plan = createWindowsUpdateTaskPlan(
			productionTaskName,
			"C:\\update.bat",
		);
		const configureError = new Error("configure failed");
		const cleanupError = new Error("delete failed");
		let thrown: unknown;

		try {
			executeWindowsUpdateTaskPlan(plan, (command) => {
				if (command === plan.configure) throw configureError;
				if (command === plan.deleteTask) throw cleanupError;
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).errors).toEqual([
			configureError,
			cleanupError,
		]);
	});
});

describe("Windows updater uninstall registration refresh", () => {
	test("uses a stable task identity scoped to identifier and channel", () => {
		const production = createWindowsUpdateTaskName(
			"com.example.app",
			"production",
		);
		const canary = createWindowsUpdateTaskName("com.example.app", "canary");

		expect(production).toBe(productionTaskName);
		expect(createWindowsUpdateTaskName("com.example.app", "production")).toBe(
			production,
		);
		expect(canary).not.toBe(production);
		expect(canary).toMatch(/^ElectrobunUpdate_[a-f0-9]{24}$/);
	});

	test("runs the channel-root uninstaller quietly without blocking legacy updates", () => {
		const batch = createWindowsRegistrationRefreshBatch(
			"C:/Users/Test User/AppData/Local/com.example.app/canary",
		);
		const invocation =
			'"C:\\Users\\Test User\\AppData\\Local\\com.example.app\\canary\\uninstall.exe" --refresh-registration --quiet';

		expect(batch).toContain(
			'if not exist "C:\\Users\\Test User\\AppData\\Local\\com.example.app\\canary\\uninstall.exe"',
		);
		expect(batch).toContain(invocation);
		expect(batch.indexOf("if not exist")).toBeLessThan(
			batch.indexOf(invocation),
		);
		expect(batch.slice(batch.indexOf(invocation))).toContain(
			"if errorlevel 1",
		);
		expect(batch).toContain(
			"goto registrationrefreshdone",
		);
		expect(batch).not.toContain("goto updatefailed");
	});

	test("escapes percent signs before embedding a path in a batch file", () => {
		const batch = createWindowsRegistrationRefreshBatch(
			"C:\\Users\\100% Real\\AppData\\Local\\Example\\production",
		);

		expect(batch).toContain(
			'"C:\\Users\\100%% Real\\AppData\\Local\\Example\\production\\uninstall.exe" --refresh-registration --quiet',
		);
		expect(batch).not.toContain('"C:\\Users\\100% Real\\');
	});

	test("rejects paths that could inject another batch command", () => {
		expect(() =>
			createWindowsRegistrationRefreshBatch(
				'C:\\Apps\\Example" & del C:\\important',
			),
		).toThrow("Invalid Windows batch argument");
	});

	test("preserves exclamation marks when delayed expansion is disabled", () => {
		const batch = createWindowsRegistrationRefreshBatch(
			"C:\\Users\\Great!User\\AppData\\Local\\Example\\production",
		);

		expect(batch).toContain(
			'"C:\\Users\\Great!User\\AppData\\Local\\Example\\production\\uninstall.exe" --refresh-registration --quiet',
		);
	});
});

describe("Windows updater replacement batch", () => {
	const options = {
		runningAppPath: "C:/Users/100% Runner!/Example/app",
		newAppPath: "C:/Users/100% Source!/Example/new app",
		extractionDirectoryPath:
			"C:/Users/100% Extract!/Example/self-extraction/unpacked",
		launcherPath: "C:/Users/100% Runner!/Example/app/bin/launcher.exe",
		registrationRefreshBatch: ":: registration refresh",
		taskCleanupBatchLine: ":: task cleanup",
	};

	test("quotes and percent-escapes every interpolated filesystem path", () => {
		const batch = createWindowsUpdateBatch(options);
		const runningApp = '"C:\\Users\\100%% Runner!\\Example\\app"';
		const newApp = '"C:\\Users\\100%% Source!\\Example\\new app"';
		const extractionDirectory =
			'"C:\\Users\\100%% Extract!\\Example\\self-extraction\\unpacked"';
		const launcher =
			'"C:\\Users\\100%% Runner!\\Example\\app\\bin\\launcher.exe"';

		expect(batch).toContain(`if not exist ${runningApp} goto rmdone`);
		expect(batch).toContain(`rmdir /s /q ${runningApp} 2>nul`);
		expect(batch).toContain(`move ${newApp} ${runningApp}`);
		expect(batch).toContain(`if not exist ${launcher} (`);
		expect(batch).toContain(
			`rmdir /s /q ${extractionDirectory} 2>nul`,
		);
		expect(batch).toContain(`start "" ${launcher}`);
	});

	test("keeps delayed expansion disabled so exclamation marks remain literal", () => {
		const batch = createWindowsUpdateBatch(options);

		expect(batch).toContain("setlocal DisableDelayedExpansion");
		expect(batch).not.toContain("EnableDelayedExpansion");
		expect(batch).toContain("100%% Runner!");
	});

	test("rejects command injection in every interpolated filesystem path", () => {
		for (const pathKey of [
			"runningAppPath",
			"newAppPath",
			"extractionDirectoryPath",
			"launcherPath",
		] as const) {
			expect(() =>
				createWindowsUpdateBatch({
					...options,
					[pathKey]: 'C:\\Apps\\Example" & del C:\\important',
				}),
			).toThrow("Invalid Windows batch argument");
		}
	});
});

describe("Linux updater uninstall metadata refresh", () => {
	test("uses the channel-root uninstaller with argv-safe quiet arguments", () => {
		const invocations: Array<{ executable: string; args: readonly string[] }> = [];
		const channelRoot =
			"/home/Test User/.local/share/com.example.app/canary channel";

		const refreshed = refreshLinuxUninstallerMetadata(
			channelRoot,
			() => true,
			(executable, args) => {
				invocations.push({ executable, args: [...args] });
			},
		);

		expect(refreshed).toBe(true);
		expect(invocations).toEqual([
			{
				executable: `${channelRoot}/uninstall`,
				args: ["--refresh-metadata", "--quiet"],
			},
		]);
	});

	test("skips a missing legacy uninstaller without executing anything", () => {
		let checkedPath = "";
		let executed = false;
		const channelRoot = "/home/test/.local/share/com.example.app/production";

		const refreshed = refreshLinuxUninstallerMetadata(
			channelRoot,
			(path) => {
				checkedPath = path;
				return false;
			},
			() => {
				executed = true;
			},
		);

		expect(refreshed).toBe(false);
		expect(checkedPath).toBe(`${channelRoot}/uninstall`);
		expect(executed).toBe(false);
	});

	test("does not propagate an uninstaller refresh failure", () => {
		const refreshError = new Error("refresh failed");

		expect(
			refreshLinuxUninstallerMetadata(
				"/home/test/.local/share/com.example.app/production",
				() => true,
				() => {
					throw refreshError;
				},
			),
		).toBe(false);
	});

	test("does not propagate an uninstaller existence-check failure", () => {
		expect(
			refreshLinuxUninstallerMetadata(
				"/home/test/.local/share/com.example.app/production",
				() => {
					throw new Error("stat failed");
				},
			),
		).toBe(false);
	});
});
