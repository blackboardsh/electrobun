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

	test("stages the bundled manager as an exe and preserves a legacy fallback", () => {
		const batch = createWindowsRegistrationRefreshBatch(
			"C:/Users/Test User/AppData/Local/com.example.app/canary",
		);
		const packagedManager =
			"C:\\Users\\Test User\\AppData\\Local\\com.example.app\\canary\\app\\Resources\\uninstall";
		const channelRoot =
			"C:\\Users\\Test User\\AppData\\Local\\com.example.app\\canary";
		const legacyInvocation =
			'"C:\\Users\\Test User\\AppData\\Local\\com.example.app\\canary\\uninstall.exe" --refresh-registration --quiet';
		const powershellInvocation = batch
			.split("\n")
			.find((line) => line.includes("WindowsPowerShell\\v1.0\\powershell.exe"));

		expect(batch).toContain(
			`if not exist "${packagedManager}" goto registrationrefreshlegacy`,
		);
		expect(powershellInvocation).toBeDefined();
		expect(powershellInvocation).toStartWith(
			'"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ',
		);
		expect(batch).not.toMatch(/^powershell\.exe\s/im);
		expect(powershellInvocation).toContain(`$sourcePath = '${packagedManager}'`);
		expect(powershellInvocation).toContain(`$channelRoot = '${channelRoot}'`);
		expect(powershellInvocation).toContain(
			"$tempRoot = [Environment]::GetEnvironmentVariable('TEMP')",
		);
		expect(powershellInvocation).toContain(
			"if ([String]::IsNullOrWhiteSpace($tempRoot)) { $tempRoot = [Environment]::GetEnvironmentVariable('TMP') }",
		);
		expect(powershellInvocation).toContain(
			"$localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA'); if (-not [String]::IsNullOrWhiteSpace($localAppData)) { $tempRoot = [IO.Path]::Combine($localAppData, 'Temp') }",
		);
		expect(powershellInvocation).toContain(
			"if ([String]::IsNullOrWhiteSpace($tempRoot)) { throw 'No Windows temporary directory is available' }",
		);
		expect(powershellInvocation).toContain(
			"[IO.Path]::Combine($tempRoot, 'electrobun-uninstall-refresh-' + [Guid]::NewGuid().ToString('N') + '.exe')",
		);
		expect(powershellInvocation?.indexOf("GetEnvironmentVariable('TEMP')")).toBeLessThan(
			powershellInvocation?.indexOf("GetEnvironmentVariable('TMP')") ?? -1,
		);
		expect(powershellInvocation?.indexOf("GetEnvironmentVariable('TMP')")).toBeLessThan(
			powershellInvocation?.indexOf("GetEnvironmentVariable('LOCALAPPDATA')") ?? -1,
		);
		expect(powershellInvocation).toContain(
			"[IO.File]::Copy($sourcePath, $stagePath, $false)",
		);
		expect(powershellInvocation).toContain(
			"$channelRootArgument = [char]34 + $channelRoot + [char]34",
		);
		expect(powershellInvocation).toContain(
			"Start-Process -FilePath $stagePath -ArgumentList @('--refresh-registration-from-update', $channelRootArgument, '--quiet') -WindowStyle Hidden -Wait -PassThru",
		);
		expect(powershellInvocation).toContain(
			"finally { Remove-Item -LiteralPath $stagePath -Force -ErrorAction SilentlyContinue }",
		);
		expect(powershellInvocation).toEndWith('exit $exitCode"');
		expect(batch).toContain(
			"if errorlevel 1 echo Warning: could not replace or refresh the Windows uninstall manager.",
		);
		expect(batch).toContain(legacyInvocation);
		expect(batch.indexOf("WindowsPowerShell\\v1.0\\powershell.exe")).toBeLessThan(
			batch.indexOf(legacyInvocation),
		);
		expect(batch).toContain(":registrationrefreshlegacy");
		expect(batch).toContain("goto registrationrefreshdone");
		expect(batch).not.toContain("goto updatefailed");
		expect(batch).not.toMatch(/^\s*if\b.*\(\s*$/m);
		expect(batch).toContain(
			":registrationrefreshdone\n:: Metadata refresh is best effort and must not make a successful update fail.\nver >nul",
		);
	});

	test("escapes percent signs before embedding a path in a batch file", () => {
		const batch = createWindowsRegistrationRefreshBatch(
			"C:\\Users\\100% Real\\AppData\\Local\\Example\\production",
		);

		expect(batch).toContain(
			"$sourcePath = 'C:\\Users\\100%% Real\\AppData\\Local\\Example\\production\\app\\Resources\\uninstall'",
		);
		expect(batch).toContain(
			"$channelRoot = 'C:\\Users\\100%% Real\\AppData\\Local\\Example\\production'",
		);
		expect(batch).not.toContain("100% Real");
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
			"$sourcePath = 'C:\\Users\\Great!User\\AppData\\Local\\Example\\production\\app\\Resources\\uninstall'",
		);
		expect(batch).toContain(
			"$channelRoot = 'C:\\Users\\Great!User\\AppData\\Local\\Example\\production'",
		);
	});

	test("escapes apostrophes in the bundled manager PowerShell command", () => {
		const batch = createWindowsRegistrationRefreshBatch(
			"C:\\Users\\O'Brien\\AppData\\Local\\Example\\production",
		);

		expect(batch).toContain(
			"$sourcePath = 'C:\\Users\\O''Brien\\AppData\\Local\\Example\\production\\app\\Resources\\uninstall'",
		);
		expect(batch).toContain(
			"$channelRoot = 'C:\\Users\\O''Brien\\AppData\\Local\\Example\\production'",
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
