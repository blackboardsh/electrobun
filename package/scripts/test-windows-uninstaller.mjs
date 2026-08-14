#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
	console.log("Windows uninstaller integration: skipped on non-Windows host");
	process.exit(0);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extractorRoot = join(packageRoot, "src", "extractor");
const launcherRoot = join(packageRoot, "src", "launcher");
const bunRuntime = join(packageRoot, "dist", "bun.exe");
const token = randomBytes(6).toString("hex");
const identifier = "com.example.electrobun-uninstaller-e2e." + token;
const unrelatedIdentifier = identifier + ".unrelated";
const appName = "ElectrobunUninstallE2E-" + token;
const version = "9.8.7";
const updatedVersion = "9.8.8";
const optimize = process.env.ELECTROBUN_WINDOWS_OPTIMIZE || "ReleaseSafe";
const focusedTest = process.env.ELECTROBUN_WINDOWS_FOCUS;
assert.equal(
	new Set(["Debug", "ReleaseSafe", "ReleaseFast", "ReleaseSmall"]).has(optimize),
	true,
	"invalid ELECTROBUN_WINDOWS_OPTIMIZE value: " + optimize,
);
assert.equal(
	focusedTest === undefined ||
		focusedTest === "update-refresh" ||
		focusedTest === "interactive",
	true,
	"invalid ELECTROBUN_WINDOWS_FOCUS value: " + focusedTest,
);
const localAppData = resolve(
	process.env.LOCALAPPDATA ||
		join(process.env.USERPROFILE || process.env.HOME || "", "AppData", "Local"),
);
let temporaryRoot;
const identifierRoot = join(localAppData, identifier);
const unrelatedRoot = join(localAppData, unrelatedIdentifier);
const registryRoot =
	"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const powerShellRegistryRoot =
	"Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const archiveMarker = Buffer.from(
	"\nELECTROBUN_E2E_ARCHIVE_BEARING_SETUP_" + token + "\n",
	"utf8",
);
const allowedChannels = new Set(["production", "canary"]);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const trackedJunctions = new Set();
const windowsTemporaryDirectory = resolve(
	process.env.TEMP || process.env.TMP || join(localAppData, "Temp"),
);
const cleanupArtifactsBefore = new Set(
	readdirSync(windowsTemporaryDirectory)
		.filter((name) =>
			/^electrobun-(?:uninstall-[0-9a-f]+\.exe|uninstall-refresh-[0-9a-f]{32}\.exe|cleanup-[0-9a-f]+\.cmd)$/i.test(
				name,
			),
		)
		.map((name) => normalizePath(join(windowsTemporaryDirectory, name))),
);
let fixtureCleanupArmed = false;

function sleep(milliseconds) {
	Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function pathExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error && error.code === "ENOENT") return false;
		throw error;
	}
}

function normalizePath(path) {
	return resolve(path).replaceAll("/", "\\").toLowerCase();
}

function assertExactOrChild(parent, candidate, label) {
	const normalizedParent = normalizePath(parent);
	const normalizedCandidate = normalizePath(candidate);
	assert.ok(
		normalizedCandidate === normalizedParent ||
			normalizedCandidate.startsWith(normalizedParent + "\\"),
		label + " escaped its allowed root: " + candidate,
	);
}

function assertExactPath(actual, expected, label) {
	assert.equal(normalizePath(actual), normalizePath(expected), label);
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function commandText(command, args) {
	return command + " " + args.map((arg) => JSON.stringify(arg)).join(" ");
}

function runRaw(command, args = [], options = {}) {
	return spawnSync(command, args, {
		cwd: options.cwd || temporaryRoot || packageRoot,
		encoding: "utf8",
		env: options.env || process.env,
		maxBuffer: 32 * 1024 * 1024,
		timeout: options.timeout || 120_000,
		windowsHide: options.windowsHide ?? true,
	});
}

function run(command, args = [], options = {}) {
	const result = runRaw(command, args, options);
	if (result.error || result.status !== 0) {
		throw new Error(
			commandText(command, args) +
				" failed (" +
				(result.status ?? result.signal) +
				"):\n" +
				(result.stdout || "") +
				"\n" +
				(result.stderr || ""),
			{ cause: result.error },
		);
	}
	return result;
}

function runExpectingFailure(command, args = [], options = {}) {
	const result = runRaw(command, args, {
		...options,
		timeout: options.timeout || 45_000,
	});
	if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;
	assert.equal(
		result.signal,
		null,
		commandText(command, args) + " was terminated by " + result.signal,
	);
	assert.notEqual(
		result.status,
		0,
		commandText(command, args) + " unexpectedly succeeded",
	);
	return result;
}

function psLiteral(value) {
	return "'" + String(value).replaceAll("'", "''") + "'";
}

function encodedPowerShell(script) {
	return Buffer.from(
		"[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); " + script,
		"utf16le",
	).toString("base64");
}

function runPowerShell(script, options = {}) {
	return run(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			encodedPowerShell(script),
		],
		options,
	);
}

function powerShellArray(values) {
	return "@(" + values.map(psLiteral).join(", ") + ")";
}

function automateTaskDialog(channel, args, action) {
	const paths = fixturePaths(channel);
	const argumentClause =
		args.length === 0 ? "" : " -ArgumentList " + powerShellArray(args);
	const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ElectrobunTaskDialogNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$process = Start-Process -FilePath ${psLiteral(paths.manager)}${argumentClause} -WorkingDirectory ${psLiteral(paths.root)} -PassThru
try {
    $pidCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $process.Id)
    $windowTypeCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
    $windowNameCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        ${psLiteral(appName)})
    $windowCondition = [System.Windows.Automation.AndCondition]::new(
        $pidCondition,
        $windowTypeCondition,
        $windowNameCondition)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $window = $null
    while ([DateTime]::UtcNow -lt $deadline -and $null -eq $window) {
        $window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $windowCondition)
        if ($null -eq $window) { Start-Sleep -Milliseconds 50 }
    }
    if ($null -eq $window) { throw 'TaskDialog did not appear' }

    $allElements = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $elementNames = @($allElements | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
    $relevantButtons = @($elementNames | Where-Object { $_ -in @('App', 'App and Data', 'Cancel') })
    $handle = [IntPtr]$window.Current.NativeWindowHandle
    $windowName = $window.Current.Name
    # DM_GETDEFID returns the default control ID in its low word.
    $defaultButtonId = [ElectrobunTaskDialogNative]::SendMessage(
        $handle, 0x0400, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64() -band 0xffff

    if (${psLiteral(action)} -eq 'close') {
        if ($handle -eq [IntPtr]::Zero -or
            -not [ElectrobunTaskDialogNative]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
            throw 'Could not close TaskDialog through its window close action'
        }
    } elseif (${psLiteral(action)} -eq 'default') {
        if (-not [ElectrobunTaskDialogNative]::PostMessage(
                $handle, 0x0100, [IntPtr]13, [IntPtr]::Zero) -or
            -not [ElectrobunTaskDialogNative]::PostMessage(
                $handle, 0x0101, [IntPtr]13, [IntPtr]::Zero)) {
            throw 'Could not invoke the TaskDialog default with Enter'
        }
    } else {
        $target = $window.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::NameProperty,
                ${psLiteral(action)}))
        if ($null -eq $target) { throw ('TaskDialog button not found: ' + ${psLiteral(action)}) }
        # TaskDialog exposes its custom command links through UIA on this VM,
        # but those elements do not advertise InvokePattern. TDM_CLICK_BUTTON
        # is the native TaskDialog equivalent of activating a configured
        # button and uses the IDs from windows_uninstall_prompt.c.
        $buttonId = switch (${psLiteral(action)}) {
            'App' { 100 }
            'App and Data' { 101 }
            'Cancel' { 2 }
            default { throw ('Unknown TaskDialog action: ' + ${psLiteral(action)}) }
        }
        $null = [ElectrobunTaskDialogNative]::SendMessage(
            $handle, 0x0466, [IntPtr]$buttonId, [IntPtr]::Zero)
    }

    if (-not $process.WaitForExit(60000)) { throw 'TaskDialog manager did not exit' }
    [ordered]@{
        buttonNames = $relevantButtons
        defaultButtonId = $defaultButtonId
        elementNames = $elementNames
        exitCode = $process.ExitCode
        windowName = $windowName
    } | ConvertTo-Json -Compress
} finally {
    if (-not $process.HasExited) { $process.Kill() }
}`;
	const output = runPowerShell(script, { timeout: 90_000 }).stdout.trim();
	const result = JSON.parse(output.split(/\r?\n/).at(-1));
	console.log("TaskDialog UI Automation: " + JSON.stringify(result));
	assert.equal(result.exitCode, 0, "interactive manager exit code");
	assert.deepEqual(
		result.buttonNames,
		["App", "App and Data", "Cancel"],
		"TaskDialog button order",
	);
	assert.equal(
		result.defaultButtonId,
		1,
		"TaskDialog native first-choice default mapping",
	);
	assert.equal(result.windowName, appName, "TaskDialog window title");
	assert.equal(
		result.elementNames.includes("Uninstall " + appName + "?"),
		true,
		"TaskDialog main instruction",
	);
	assert.equal(
		result.elementNames.includes("The application will be removed."),
		true,
		"TaskDialog message",
	);
	return result;
}

function automateInstalledAppsUninstall(channel) {
	const paths = fixturePaths(channel);
	const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ElectrobunInstalledAppsNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@

function Find-Until($root, $scope, $condition, $description, $seconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $element = $root.FindFirst($scope, $condition)
        if ($null -ne $element) { return $element }
        Start-Sleep -Milliseconds 100
    }
    throw ('Timed out waiting for ' + $description)
}

function Invoke-UiElement($element, $description) {
    try {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
    } catch {
        throw ('Could not invoke ' + $description + ': ' + $_.Exception.Message)
    }
}

function Runtime-Key($element) {
    return (($element.GetRuntimeId() | ForEach-Object { $_.ToString() }) -join '.')
}

$settingsFrame = $null
$settingsHandle = [IntPtr]::Zero
try {
    Start-Process 'ms-settings:appsfeatures'
    $frameName = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        'Settings')
    $frameClass = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        'ApplicationFrameWindow')
    $frameCondition = [System.Windows.Automation.AndCondition]::new($frameName, $frameClass)
    $settingsFrame = Find-Until ([System.Windows.Automation.AutomationElement]::RootElement) ([System.Windows.Automation.TreeScope]::Children) $frameCondition 'the Installed Apps Settings window'
    $settingsHandle = [IntPtr]$settingsFrame.Current.NativeWindowHandle

    $searchCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
        'SystemSettings_StorageSense_AppSizesListFilter_DisplayStringValue')
    $search = Find-Until $settingsFrame ([System.Windows.Automation.TreeScope]::Descendants) $searchCondition 'the Installed Apps search field'
    $valuePattern = $search.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $valuePattern.SetValue(${psLiteral(appName)})

    $listItemCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::ListItem)
    $appEntry = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline -and $null -eq $appEntry) {
        $items = $settingsFrame.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $listItemCondition)
        $matches = @($items | Where-Object {
            $_.Current.Name -eq ${psLiteral(appName)} -or
            $_.Current.Name.StartsWith(${psLiteral(appName + ",")})
        })
        if ($matches.Count -gt 1) { throw 'Installed Apps showed more than one fixture entry' }
        if ($matches.Count -eq 1) { $appEntry = $matches[0] }
        if ($null -eq $appEntry) { Start-Sleep -Milliseconds 100 }
    }
    if ($null -eq $appEntry) { throw 'Fixture did not appear in Installed Apps' }
    $appEntryName = $appEntry.Current.Name

    $moreCondition = [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            'More options'),
        [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button))
    $more = $appEntry.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants,
        $moreCondition)
    if ($null -eq $more) { throw 'Fixture Installed Apps entry had no More options button' }
    Invoke-UiElement $more 'the fixture More options button'

    $uninstallName = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        'Uninstall')
    $firstUninstall = Find-Until ([System.Windows.Automation.AutomationElement]::RootElement) ([System.Windows.Automation.TreeScope]::Descendants) $uninstallName 'the Installed Apps Uninstall action'
    $firstUninstallKey = Runtime-Key $firstUninstall
    $firstUninstallType = $firstUninstall.Current.ControlType.ProgrammaticName
    Invoke-UiElement $firstUninstall 'the Installed Apps Uninstall action'

    $dialogName = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        ${psLiteral(appName)})
    $dialogType = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
    $dialogCondition = [System.Windows.Automation.AndCondition]::new($dialogName, $dialogType)
    $dialog = $null
    $confirmUninstallType = $null
    $confirmationClicked = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline -and $null -eq $dialog) {
        $dialog = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            $dialogCondition)
        if ($null -ne $dialog) { break }

        $uninstallCandidates = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            $uninstallName)
        $confirmation = @($uninstallCandidates | Where-Object {
            $_.Current.IsEnabled -and (Runtime-Key $_) -ne $firstUninstallKey
        }) | Select-Object -First 1
        if ($null -ne $confirmation) {
            $confirmUninstallType = $confirmation.Current.ControlType.ProgrammaticName
            Invoke-UiElement $confirmation 'the Installed Apps uninstall confirmation'
            $confirmationClicked = $true
        }
        Start-Sleep -Milliseconds 100
    }
    if ($null -eq $dialog) {
        $dialog = Find-Until ([System.Windows.Automation.AutomationElement]::RootElement) ([System.Windows.Automation.TreeScope]::Descendants) $dialogCondition 'the external manager TaskDialog'
    }

    $dialogElements = $dialog.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
    $dialogNames = @($dialogElements | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
    if ($dialogNames -notcontains 'App') { throw 'External manager TaskDialog had no App choice' }
    $dialogHandle = [IntPtr]$dialog.Current.NativeWindowHandle
    $null = [ElectrobunInstalledAppsNative]::SendMessage(
        $dialogHandle, 0x0466, [IntPtr]100, [IntPtr]::Zero)

    [ordered]@{
        appEntryName = $appEntryName
        confirmationClicked = $confirmationClicked
        confirmationType = $confirmUninstallType
        dialogNames = $dialogNames
        firstUninstallType = $firstUninstallType
        settingsWindowName = $settingsFrame.Current.Name
    } | ConvertTo-Json -Compress
} finally {
    if ($settingsHandle -ne [IntPtr]::Zero) {
        $null = [ElectrobunInstalledAppsNative]::PostMessage(
            $settingsHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    }
}`;
	const output = runPowerShell(script, { timeout: 120_000 }).stdout.trim();
	const result = JSON.parse(output.split(/\r?\n/).at(-1));
	console.log("Installed Apps UI Automation: " + JSON.stringify(result));
	assert.equal(result.settingsWindowName, "Settings");
	assert.equal(
		result.appEntryName === appName ||
			result.appEntryName.startsWith(appName + ","),
		true,
		"Installed Apps fixture entry",
	);
	assert.equal(result.dialogNames.includes("App"), true);
	assert.equal(
		registryProperties(channel).UninstallString,
		'"' + paths.manager + '" --uninstall',
	);
	return result;
}

function waitFor(predicate, description, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			if (predicate()) return;
		} catch (error) {
			lastError = error;
		}
		sleep(50);
	}
	if (lastError) throw lastError;
	assert.fail(description + " did not become true within " + timeoutMs + "ms");
}

function newCleanupArtifacts() {
	return readdirSync(windowsTemporaryDirectory)
		.filter((name) =>
			/^electrobun-(?:uninstall-[0-9a-f]+\.exe|uninstall-refresh-[0-9a-f]{32}\.exe|cleanup-[0-9a-f]+\.cmd)$/i.test(
				name,
			),
		)
		.map((name) => join(windowsTemporaryDirectory, name))
		.filter((path) => !cleanupArtifactsBefore.has(normalizePath(path)));
}

function assertNoNewCleanupArtifacts() {
	waitFor(
		() => newCleanupArtifacts().length === 0,
		"temporary uninstaller worker cleanup",
		45_000,
	);
	assert.deepEqual(newCleanupArtifacts(), []);
}

function findZig() {
	const executable = process.platform === "win32" ? "zig.exe" : "zig";
	const candidates = [
		process.env.ELECTROBUN_ZIG,
		join(packageRoot, "vendors", "zig", executable),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (!pathExists(candidate)) continue;
		const probe = runRaw(candidate, ["version"], { timeout: 10_000 });
		if (probe.status === 0 && /^0\.16\./.test((probe.stdout || "").trim())) {
			return candidate;
		}
	}
	throw new Error(
		"Windows uninstaller integration requires Zig 0.16; set ELECTROBUN_ZIG or refresh package/vendors/zig",
	);
}

function runZigBuild(zig, projectRoot, buildArguments) {
	const cacheName = projectRoot === extractorRoot ? "extractor" : "launcher";
	return run(
		zig,
		[
			"build",
			...buildArguments,
			"--cache-dir",
			join(temporaryRoot, "zig-cache-" + cacheName),
			"--global-cache-dir",
			join(temporaryRoot, "zig-global-cache"),
		],
		{ cwd: projectRoot, timeout: 180_000 },
	);
}

function windowsKnownFolder(name, fallback) {
	const value = runPowerShell(
		"[Environment]::GetFolderPath([Environment+SpecialFolder]::" + name + ")",
	).stdout.trim();
	return value && isAbsolute(value) ? value : fallback;
}

const userProfile = process.env.USERPROFILE || dirname(localAppData);
const desktopDirectory = windowsKnownFolder(
	"DesktopDirectory",
	join(userProfile, "Desktop"),
);
const programsDirectory = windowsKnownFolder(
	"Programs",
	join(
		process.env.APPDATA || join(userProfile, "AppData", "Roaming"),
		"Microsoft",
		"Windows",
		"Start Menu",
		"Programs",
	),
);
temporaryRoot = realpathSync(
	mkdtempSync(join(tmpdir(), "electrobun-windows-uninstaller-e2e-")),
);
const unrelatedShortcut = join(
	desktopDirectory,
	appName + "-unrelated-user-shortcut.lnk",
);

function channelRoot(channel) {
	assert.equal(
		allowedChannels.has(channel),
		true,
		"refusing an unscoped fixture channel: " + channel,
	);
	return join(identifierRoot, channel);
}

function registryKey(channel) {
	return registryRoot + "\\" + identifier + "." + channel;
}

function powerShellRegistryKey(channel) {
	return powerShellRegistryRoot + "\\" + identifier + "." + channel;
}

function updateTaskName(channel) {
	const scope = createHash("sha256")
		.update(identifier)
		.update("\0")
		.update(channel)
		.digest("hex")
		.slice(0, 24);
	return "ElectrobunUpdate_" + scope;
}

function shortcutName(channel) {
	if (channel === "production") return appName + ".lnk";
	if (channel === "canary") return appName + " (Canary).lnk";
	if (channel === "dev") return appName + " (Development).lnk";
	return appName + " (" + channel + ").lnk";
}

function expectedDesktopShortcut(channel) {
	return join(desktopDirectory, shortcutName(channel));
}

function expectedStartShortcut(channel) {
	return join(programsDirectory, shortcutName(channel));
}

function fixturePaths(channel) {
	const root = channelRoot(channel);
	return {
		app: join(root, "app"),
		appMarker: join(root, "app", "Resources", "fixture.keep"),
		desktopShortcut: expectedDesktopShortcut(channel),
		launcher: join(root, "app", "bin", "launcher.exe"),
		manager: join(root, "uninstall.exe"),
		manifest: join(root, ".electrobun-uninstall.json"),
		packagedManager: join(root, "app", "Resources", "uninstall"),
		registryKey: registryKey(channel),
		root,
		selfExtraction: join(root, "self-extraction"),
		startShortcut: expectedStartShortcut(channel),
		updateScript: join(root, "update.bat"),
		userSentinel: join(root, "user-created-data.keep"),
		unknownSentinel: join(root, "unknown", "nested.keep"),
	};
}

function registryExists(channel) {
	const result = runPowerShell(
		"if (Test-Path -LiteralPath " +
			psLiteral(powerShellRegistryKey(channel)) +
			") { 'true' } else { 'false' }",
	);
	return result.stdout.trim().toLowerCase() === "true";
}

function registryProperties(channel) {
	const key = psLiteral(powerShellRegistryKey(channel));
	const script =
		"$p = Get-ItemProperty -LiteralPath " +
		key +
		" -ErrorAction Stop; " +
		"[ordered]@{" +
		"DisplayName=$p.DisplayName;" +
		"DisplayVersion=$p.DisplayVersion;" +
		"DisplayIcon=$p.DisplayIcon;" +
		"InstallLocation=$p.InstallLocation;" +
		"UninstallString=$p.UninstallString;" +
		"QuietUninstallString=$p.QuietUninstallString" +
		"} | ConvertTo-Json -Compress";
	return JSON.parse(runPowerShell(script).stdout.trim());
}

function deleteRegistry(channel) {
	runRaw("reg.exe", [
		"delete",
		registryKey(channel),
		"/f",
		"/reg:64",
	], { timeout: 10_000 });
}

function shortcutTarget(path) {
	if (!pathExists(path)) return null;
	const script =
		"$s = (New-Object -ComObject WScript.Shell).CreateShortcut(" +
		psLiteral(path) +
		"); $s.TargetPath";
	return runPowerShell(script).stdout.trim();
}

function taskExists(channel) {
	return (
		runRaw("schtasks.exe", [
			"/query",
			"/tn",
			updateTaskName(channel),
		], { timeout: 10_000 }).status === 0
	);
}

function createUpdateTask(channel) {
	run("schtasks.exe", [
		"/create",
		"/tn",
		updateTaskName(channel),
		"/tr",
		"cmd.exe /d /c exit 0",
		"/sc",
		"once",
		"/st",
		"00:00",
		"/f",
	]);
	assert.equal(taskExists(channel), true, "fixture update task was not created");
}

function deleteUpdateTask(channel) {
	runRaw("schtasks.exe", [
		"/end",
		"/tn",
		updateTaskName(channel),
	], { timeout: 10_000 });
	runRaw("schtasks.exe", [
		"/delete",
		"/tn",
		updateTaskName(channel),
		"/f",
	], { timeout: 10_000 });
}

function removeTrackedJunction(path) {
	if (!pathExists(path)) {
		trackedJunctions.delete(path);
		return;
	}
	try {
		unlinkSync(path);
	} catch {
		try {
			rmdirSync(path);
		} catch {}
	}
	if (pathExists(path)) {
		throw new Error("refusing recursive cleanup while junction remains: " + path);
	}
	trackedJunctions.delete(path);
}

function removeExactShortcut(path, expectedParent) {
	assertExactOrChild(expectedParent, path, "shortcut cleanup");
	assertExactPath(dirname(path), expectedParent, "shortcut cleanup parent");
	try {
		unlinkSync(path);
	} catch (error) {
		if (!error || error.code !== "ENOENT") throw error;
	}
}

function resetChannel(channel) {
	const paths = fixturePaths(channel);
	deleteUpdateTask(channel);
	deleteRegistry(channel);
	removeExactShortcut(paths.desktopShortcut, desktopDirectory);
	removeExactShortcut(paths.startShortcut, programsDirectory);
	for (const junction of [...trackedJunctions]) {
		if (
			normalizePath(junction) === normalizePath(paths.root) ||
			normalizePath(junction).startsWith(normalizePath(paths.root) + "\\")
		) {
			removeTrackedJunction(junction);
		}
	}
	assertExactPath(paths.root, join(localAppData, identifier, channel), "channel cleanup");
	assertExactOrChild(identifierRoot, paths.root, "channel cleanup");
	rmSync(paths.root, { force: true, recursive: true });
	try {
		rmdirSync(identifierRoot);
	} catch {}
}

function createJunction(path, target) {
	assertExactOrChild(identifierRoot, path, "junction fixture");
	mkdirSync(dirname(path), { recursive: true });
	runPowerShell(
		"New-Item -ItemType Junction -Path " +
			psLiteral(path) +
			" -Target " +
			psLiteral(target) +
			" -ErrorAction Stop | Out-Null",
	);
	trackedJunctions.add(path);
	assert.equal(lstatSync(path).isSymbolicLink(), true, "junction was not created");
}

function walkSnapshot(root) {
	if (!pathExists(root)) return [];
	const entries = [];
	function walk(path, relativePath) {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) {
			entries.push({ kind: "reparse", path: relativePath });
			return;
		}
		if (stat.isDirectory()) {
			entries.push({ kind: "directory", path: relativePath });
			for (const name of readdirSync(path).sort()) {
				walk(join(path, name), join(relativePath, name));
			}
			return;
		}
		entries.push({
			hash: sha256File(path),
			kind: "file",
			path: relativePath,
			size: stat.size,
		});
	}
	walk(root, ".");
	return entries;
}

function captureFixture(channel) {
	const paths = fixturePaths(channel);
	return {
		desktopTarget: shortcutTarget(paths.desktopShortcut),
		files: walkSnapshot(paths.root),
		registry: registryExists(channel) ? registryProperties(channel) : null,
		startTarget: shortcutTarget(paths.startShortcut),
		task: taskExists(channel),
	};
}

function assertFixtureUnchanged(channel, before, label) {
	assert.deepEqual(captureFixture(channel), before, label);
}

function readManifest(channel) {
	return JSON.parse(readFileSync(fixturePaths(channel).manifest, "utf8"));
}

function assertRegistration(channel, expectedVersion = version) {
	const paths = fixturePaths(channel);
	assert.equal(registryExists(channel), true, "Installed Apps key is missing");
	const values = registryProperties(channel);
	const expectedDisplayName =
		channel === "production"
			? appName
			: channel === "canary"
				? appName + " (Canary)"
				: appName + " (" + channel + ")";
	assert.equal(values.DisplayName, expectedDisplayName);
	assert.equal(values.DisplayVersion, expectedVersion);
	assertExactPath(values.InstallLocation, paths.app, "InstallLocation");
	assert.equal(
		values.UninstallString,
		'"' + paths.manager + '" --uninstall',
	);
	assert.equal(
		values.QuietUninstallString,
		'"' + paths.manager + '" --uninstall --quiet',
	);
	assert.ok(
		String(values.DisplayIcon).toLowerCase().includes(
			paths.launcher.toLowerCase(),
		),
		"DisplayIcon does not reference the channel launcher",
	);
}

function assertShortcuts(channel) {
	const paths = fixturePaths(channel);
	assertExactPath(
		shortcutTarget(paths.desktopShortcut),
		paths.launcher,
		"Desktop shortcut target",
	);
	assertExactPath(
		shortcutTarget(paths.startShortcut),
		paths.launcher,
		"Start Menu shortcut target",
	);
}

function assertInstalled(channel, setup, expectedVersion = version) {
	const paths = fixturePaths(channel);
	for (const path of [
		paths.app,
		paths.appMarker,
		paths.launcher,
		paths.packagedManager,
		paths.manager,
		paths.manifest,
		paths.selfExtraction,
	]) {
		assert.equal(pathExists(path), true, path + " should exist");
	}
	assert.equal(
		sha256File(paths.manager),
		sha256File(paths.packagedManager),
		"external manager is not the bundled thin resource",
	);
	assert.notEqual(
		sha256File(paths.manager),
		sha256File(setup.path),
		"external manager was copied from the archive-bearing Setup",
	);
	assert.ok(
		statSync(paths.manager).size < statSync(setup.path).size,
		"external manager is not thinner than the archive-bearing Setup",
	);
	const manifest = readManifest(channel);
	assert.equal(manifest.identifier, identifier);
	assert.equal(manifest.channel, channel);
	assert.equal(manifest.name, appName);
	assert.match(manifest.install_nonce, /^[0-9a-f]{32}$/i);
	assert.deepEqual(
		manifest.data_path_versions,
		[1],
		"manifest must record only the versioned managed-path policy",
	);
	assert.equal("cleanup_paths" in manifest, false);
	assert.equal("user_data_paths" in manifest, false);
	assertExactPath(
		manifest.desktop_shortcut,
		paths.desktopShortcut,
		"manifest Desktop shortcut",
	);
	assertExactPath(
		manifest.start_menu_shortcut,
		paths.startShortcut,
		"manifest Start Menu shortcut",
	);
	assertRegistration(channel, expectedVersion);
	assertShortcuts(channel);
	return { manifest, paths };
}

function seedState(channel, options = {}) {
	const paths = fixturePaths(channel);
	mkdirSync(dirname(paths.unknownSentinel), { recursive: true });
	writeFileSync(paths.userSentinel, "user data " + channel + "\n");
	writeFileSync(paths.unknownSentinel, "unknown user file " + channel + "\n");
	writeFileSync(paths.updateScript, "@echo off\nrem fixture updater\n");
	if (options.task) createUpdateTask(channel);
	return paths;
}

function waitForManagerCleanup(channel) {
	const paths = fixturePaths(channel);
	waitFor(
		() => !pathExists(paths.manager) && !pathExists(paths.manifest),
		"deferred manager cleanup for " + channel,
		35_000,
	);
}

function assertAppOnlyRemoved(channel, installation) {
	const paths = fixturePaths(channel);
	waitForManagerCleanup(channel);
	for (const path of [
		paths.app,
		paths.selfExtraction,
		paths.updateScript,
		paths.manager,
		paths.manifest,
		installation.manifest.desktop_shortcut,
		installation.manifest.start_menu_shortcut,
	]) {
		assert.equal(pathExists(path), false, path + " should have been removed");
	}
	assert.equal(registryExists(channel), false, "Installed Apps key survived");
	assert.equal(taskExists(channel), false, "scheduled updater task survived");
	assert.equal(pathExists(paths.userSentinel), true, "user data was removed");
	assert.equal(pathExists(paths.unknownSentinel), true, "unknown data was removed");
}

function assertDataRemoved(channel) {
	waitFor(
		() => !pathExists(channelRoot(channel)),
		"app-and-data channel-root cleanup for " + channel,
		40_000,
	);
	assert.equal(registryExists(channel), false, "Installed Apps key survived");
	assert.equal(taskExists(channel), false, "scheduled updater task survived");
	assert.equal(pathExists(expectedDesktopShortcut(channel)), false);
	assert.equal(pathExists(expectedStartShortcut(channel)), false);
}

const setups = new Map();

function buildSetup(channel, extractor, launcher, zigZstd) {
	const setupRoot = join(temporaryRoot, "setup-" + channel);
	const payloadRoot = join(setupRoot, "payload");
	const bundleName =
		channel === "production" ? appName : appName + "-" + channel;
	const bundle = join(payloadRoot, bundleName);
	const resources = join(bundle, "Resources");
	const bin = join(bundle, "bin");
	const installerDirectory = join(setupRoot, ".installer");
	const setupName =
		appName + "-Setup" + (channel === "production" ? "" : "-" + channel);
	const setupPath = join(setupRoot, setupName + ".exe");
	const tarPath = join(setupRoot, setupName + ".tar");
	const archivePath = join(installerDirectory, setupName + ".tar.zst");
	const metadataPath = join(
		installerDirectory,
		setupName + ".metadata.json",
	);

	mkdirSync(resources, { recursive: true });
	mkdirSync(bin, { recursive: true });
	mkdirSync(installerDirectory, { recursive: true });
	copyFileSync(launcher, join(bin, "launcher.exe"));
	// A broken launcher delegation would execute this extractor-shaped runtime.
	// Its distinctive startup output makes that observable without a WebView.
	copyFileSync(extractor, join(bin, "main.exe"));
	copyFileSync(extractor, join(resources, "uninstall"));
	writeFileSync(
		join(resources, "version.json"),
		JSON.stringify(
			{
				channel,
				identifier,
				name: appName,
				version,
			},
			null,
			2,
		) + "\n",
	);
	writeFileSync(
		join(resources, "build.json"),
		JSON.stringify({ mainProcess: "zig" }, null, 2) + "\n",
	);
	writeFileSync(join(resources, "fixture.keep"), "installed app fixture\n");

	run("tar.exe", ["-cf", tarPath, "-C", payloadRoot, bundleName]);
	run(zigZstd, [
		"compress",
		"-i",
		tarPath,
		"-o",
		archivePath,
		"-l",
		"1",
		"--no-timing",
	]);
	const hash = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
	writeFileSync(
		metadataPath,
		JSON.stringify(
			{ channel, hash, identifier, name: appName },
			null,
			2,
		) + "\n",
	);

	copyFileSync(extractor, setupPath);
	appendFileSync(setupPath, archiveMarker);
	appendFileSync(setupPath, readFileSync(archivePath));
	const setup = {
		archivePath,
		bundledManager: join(resources, "uninstall"),
		path: setupPath,
	};
	setups.set(channel, setup);
	return setup;
}

function install(channel, options = {}) {
	if (!options.allowExisting) resetChannel(channel);
	const setup = setups.get(channel);
	assert.ok(setup, "missing Setup fixture for " + channel);
	run(setup.path, [], { timeout: 120_000, windowsHide: false });
	const paths = fixturePaths(channel);
	waitFor(
		() =>
			pathExists(paths.manager) &&
			pathExists(paths.manifest) &&
			registryExists(channel),
		"installation integration for " + channel,
	);
	return assertInstalled(channel, setup, options.version || version);
}

function runManager(channel, args, options = {}) {
	return run(fixturePaths(channel).manager, args, {
		...options,
		cwd: fixturePaths(channel).root,
		windowsHide: options.windowsHide ?? true,
	});
}

function runManagerExpectingFailure(channel, args, options = {}) {
	return runExpectingFailure(fixturePaths(channel).manager, args, {
		...options,
		cwd: fixturePaths(channel).root,
	});
}

function runStrictCliAndCleanupTests() {
	console.log("Testing strict manager CLI and app-only cleanup...");
	const channel = "production";
	const installation = install(channel);
	const paths = seedState(channel, { task: true });
	const outsideTarget = join(temporaryRoot, "app-only-user-junction-target");
	const outsideSentinel = join(outsideTarget, "outside.keep");
	mkdirSync(outsideTarget, { recursive: true });
	writeFileSync(outsideSentinel, "outside user data\n");
	const userJunction = join(paths.root, "user-owned-junction");
	createJunction(userJunction, outsideTarget);

	const invalidArguments = [
		["--delete-data"],
		["--uninstall", "--delete-data"],
		["--delete-data", "--quiet"],
		["--quiet", "--uninstall"],
		["--uninstall", "--quiet", "--quiet"],
		["--quiet", "--delete-data", "--delete-data"],
		["--uninstall", "--quiet", "--delete-data", "--extra"],
		["--uninstall", "--uninstall"],
		["--bogus"],
		["--cleanup-uninstaller"],
	];
	for (const args of invalidArguments) {
		const before = captureFixture(channel);
		runManagerExpectingFailure(channel, args);
		assertFixtureUnchanged(
			channel,
			before,
			"invalid arguments mutated state: " + JSON.stringify(args),
		);
		assert.equal(pathExists(outsideSentinel), true);
	}

	runManager(channel, ["--quiet"]);
	assertAppOnlyRemoved(channel, installation);
	assert.equal(pathExists(userJunction), true, "app-only inspected user data");
	assert.equal(pathExists(outsideSentinel), true, "app-only followed user junction");
	resetChannel(channel);

	const delegated = install(channel);
	seedState(channel);
	runManager(channel, ["--uninstall", "--quiet"]);
	assertAppOnlyRemoved(channel, delegated);
	resetChannel(channel);

	console.log("Testing both quiet app-and-data forms...");
	for (const args of [
		["--quiet", "--delete-data"],
		["--uninstall", "--quiet", "--delete-data"],
	]) {
		const dataInstallation = install(channel);
		const dataPaths = seedState(channel, { task: true });
		const protectedRoot = join(
			temporaryRoot,
			"data-junction-target-" + args.length + "-" + randomBytes(2).toString("hex"),
		);
		const protectedSentinel = join(protectedRoot, "outside.keep");
		mkdirSync(protectedRoot, { recursive: true });
		writeFileSync(protectedSentinel, "must survive data cleanup\n");
		const childJunction = join(dataPaths.root, "application-owned-link");
		createJunction(childJunction, protectedRoot);
		runManager(channel, args);
		assertDataRemoved(channel);
		trackedJunctions.delete(childJunction);
		assert.equal(
			pathExists(protectedSentinel),
			true,
			"app-and-data followed a child junction",
		);
		assert.ok(dataInstallation.manifest.install_nonce);
	}
}

function runChannelIsolationTests() {
	console.log("Testing production/canary isolation...");
	resetChannel("production");
	resetChannel("canary");
	const production = install("production");
	const productionPaths = seedState("production", { task: true });
	const canary = install("canary");
	const canaryPaths = seedState("canary", { task: true });
	const productionBeforeCanaryUninstall = captureFixture("production");
	mkdirSync(unrelatedRoot, { recursive: true });
	const unrelatedSentinel = join(unrelatedRoot, "unrelated.keep");
	writeFileSync(unrelatedSentinel, "unrelated identifier\n");
	writeFileSync(unrelatedShortcut, "not an Electrobun-owned shortcut\n");

	runManager("canary", ["--uninstall", "--quiet"]);
	assertAppOnlyRemoved("canary", canary);
	assertFixtureUnchanged(
		"production",
		productionBeforeCanaryUninstall,
		"canary uninstall mutated production state",
	);
	for (const path of [
		productionPaths.app,
		productionPaths.manager,
		productionPaths.manifest,
		productionPaths.userSentinel,
		productionPaths.desktopShortcut,
		productionPaths.startShortcut,
		unrelatedSentinel,
		unrelatedShortcut,
	]) {
		assert.equal(pathExists(path), true, path + " was damaged by canary uninstall");
	}
	assertRegistration("production");
	assert.equal(taskExists("production"), true);

	resetChannel("canary");
	const reinstalledCanary = install("canary");
	seedState("canary", { task: true });
	const canaryBeforeProductionUninstall = captureFixture("canary");
	runManager("production", ["--uninstall", "--quiet", "--delete-data"]);
	assertDataRemoved("production");
	assertFixtureUnchanged(
		"canary",
		canaryBeforeProductionUninstall,
		"production uninstall mutated canary state",
	);
	for (const path of [
		canaryPaths.root,
		fixturePaths("canary").app,
		fixturePaths("canary").manager,
		fixturePaths("canary").manifest,
		unrelatedSentinel,
		unrelatedShortcut,
	]) {
		assert.equal(pathExists(path), true, path + " was damaged by production uninstall");
	}
	assertRegistration("canary");
	assertShortcuts("canary");
	assert.ok(reinstalledCanary.manifest.install_nonce);
	assert.ok(production.manifest.install_nonce);
	resetChannel("canary");
}

function runDamagedAppTest() {
	console.log("Testing uninstall with a missing/damaged app...");
	const installation = install("production");
	const paths = seedState("production", { task: true });
	assertExactOrChild(paths.root, paths.app, "damaged-app fixture cleanup");
	rmSync(paths.app, { force: true, recursive: true });
	runManager("production", ["--uninstall", "--quiet"]);
	assertAppOnlyRemoved("production", installation);
	resetChannel("production");
}

function runLocationAndJunctionSafetyTests() {
	console.log("Testing unexpected manager location and junction rejection...");
	install("production");
	seedState("production", { task: true });
	const realBefore = captureFixture("production");
	const fakeRoot = join(
		temporaryRoot,
		"unexpected-manager-location",
		identifier,
		"production",
	);
	mkdirSync(join(fakeRoot, "app"), { recursive: true });
	mkdirSync(join(fakeRoot, "self-extraction"), { recursive: true });
	copyFileSync(fixturePaths("production").manager, join(fakeRoot, "uninstall.exe"));
	copyFileSync(
		fixturePaths("production").manifest,
		join(fakeRoot, ".electrobun-uninstall.json"),
	);
	writeFileSync(join(fakeRoot, "app", "outside.keep"), "outside fake app\n");
	writeFileSync(
		join(fakeRoot, "self-extraction", "outside.keep"),
		"outside fake updater\n",
	);
	const fakeBefore = walkSnapshot(fakeRoot);
	runExpectingFailure(join(fakeRoot, "uninstall.exe"), ["--quiet"], {
		cwd: fakeRoot,
	});
	assertFixtureUnchanged(
		"production",
		realBefore,
		"unexpected manager location mutated the real installation",
	);
	assert.deepEqual(
		walkSnapshot(fakeRoot),
		fakeBefore,
		"unexpected manager location mutated its outside tree",
	);

	const paths = fixturePaths("production");
	const outsideApp = join(temporaryRoot, "junction-escape-target");
	const outsideSentinel = join(outsideApp, "outside.keep");
	mkdirSync(join(outsideApp, "bin"), { recursive: true });
	writeFileSync(outsideSentinel, "junction escape target\n");
	copyFileSync(
		join(launcherRoot, "zig-out", "bin", "launcher.exe"),
		join(outsideApp, "bin", "launcher.exe"),
	);
	assertExactOrChild(paths.root, paths.app, "junction fixture cleanup");
	rmSync(paths.app, { force: true, recursive: true });
	createJunction(paths.app, outsideApp);
	const beforeJunctionAttempt = captureFixture("production");
	runManagerExpectingFailure("production", ["--uninstall", "--quiet"]);
	assertFixtureUnchanged(
		"production",
		beforeJunctionAttempt,
		"junction rejection occurred after a mutation",
	);
	assert.equal(pathExists(outsideSentinel), true, "junction target was modified");
	resetChannel("production");
}

function runLauncherDelegationTest() {
	console.log("Testing launcher delegation before runtime startup...");
	const installation = install("production");
	const paths = seedState("production");
	const result = runRaw(paths.launcher, ["--uninstall", "--quiet"], {
		cwd: dirname(paths.launcher),
		timeout: 45_000,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			"launcher delegation failed (" +
				(result.status ?? result.signal) +
				"):\n" +
				(result.stdout || "") +
				"\n" +
				(result.stderr || ""),
			{ cause: result.error },
		);
	}
	assert.equal(
		((result.stdout || "") + (result.stderr || "")).includes(
			"Electrobun self-extractor v1.3 starting",
		),
		false,
		"launcher started the extractor-shaped app runtime during delegation",
	);
	waitFor(
		() => !pathExists(paths.app) && !pathExists(paths.manager),
		"launcher-delegated uninstall",
		35_000,
	);
	assertAppOnlyRemoved("production", installation);
	resetChannel("production");
}

function runUpdateRefreshTest(extractor) {
	console.log("Testing manager replacement and registration refresh after update...");
	assert.equal(
		pathExists(bunRuntime),
		true,
		"required staged Bun runtime is missing: " + bunRuntime,
	);
	const installation = install("production");
	const paths = seedState("production");
	const oldManagerHash = sha256File(paths.manager);
	const oldNonce = installation.manifest.install_nonce;
	const channelEntriesBeforeRefresh = readdirSync(paths.root).sort();
	writeFileSync(
		join(paths.app, "Resources", "version.json"),
		JSON.stringify(
			{
				channel: "production",
				identifier,
				name: appName,
				version: updatedVersion,
			},
			null,
			2,
		) + "\n",
	);
	copyFileSync(extractor, paths.packagedManager);
	appendFileSync(
		paths.packagedManager,
		Buffer.from("\nELECTROBUN_UPDATED_MANAGER_" + token + "\n"),
	);
	const newManagerHash = sha256File(paths.packagedManager);
	assert.notEqual(newManagerHash, oldManagerHash);
	const refreshBatch = join(
		temporaryRoot,
		"generated-update-refresh-" + token + ".bat",
	);
	const generatorSource =
		'import { createWindowsRegistrationRefreshBatch } from "./src/sdks/main/core/Updater.ts"; ' +
		"process.stdout.write(createWindowsRegistrationRefreshBatch(" +
		JSON.stringify(paths.root) +
		"));";
	const generatedRefresh = run(bunRuntime, ["-e", generatorSource], {
		cwd: packageRoot,
		timeout: 30_000,
	}).stdout;
	assert.match(generatedRefresh, /--refresh-registration-from-update/);
	writeFileSync(
		refreshBatch,
		"@echo off\r\nsetlocal DisableDelayedExpansion\r\n" +
			generatedRefresh.replaceAll("\n", "\r\n") +
			"\r\nexit /b %errorlevel%\r\n",
	);
	try {
		run(process.env.ComSpec || "cmd.exe", ["/d", "/c", refreshBatch], {
			cwd: paths.root,
			timeout: 60_000,
		});
	} finally {
		rmSync(refreshBatch, { force: true });
	}
	assert.equal(pathExists(refreshBatch), false, "generated refresh batch survived");
	waitFor(
		() => pathExists(paths.manager) && sha256File(paths.manager) === newManagerHash,
		"atomic Windows manager replacement",
	);
	const refreshedManifest = readManifest("production");
	assert.notEqual(
		refreshedManifest.install_nonce,
		oldNonce,
		"manager refresh did not rotate its install nonce",
	);
	assertRegistration("production", updatedVersion);
	assert.deepEqual(
		readdirSync(paths.root).sort(),
		channelEntriesBeforeRefresh,
		"manager refresh left an atomic staging file",
	);
	runManager("production", ["--quiet"]);
	assertAppOnlyRemoved("production", {
		manifest: refreshedManifest,
		paths,
	});
	resetChannel("production");
}

function runNonceRaceTest() {
	console.log("Testing deterministic stale-worker nonce protection...");
	const first = install("production");
	const paths = seedState("production");
	const sentinelContents = readFileSync(paths.userSentinel, "utf8");
	const staleWorker = join(
		windowsTemporaryDirectory,
		"electrobun-uninstall-" + randomBytes(8).toString("hex") + ".exe",
	);
	copyFileSync(paths.manager, staleWorker);
	const second = install("production", { allowExisting: true });
	assert.notEqual(
		second.manifest.install_nonce,
		first.manifest.install_nonce,
		"reinstall reused the previous install nonce",
	);
	assert.equal(readFileSync(paths.userSentinel, "utf8"), sentinelContents);
	const beforeStaleWorker = captureFixture("production");
	run(staleWorker, [
		"--cleanup-uninstaller",
		paths.manager,
		paths.manifest,
		first.manifest.install_nonce,
	]);
	waitFor(() => !pathExists(staleWorker), "stale temporary worker self-cleanup");
	assertFixtureUnchanged(
		"production",
		beforeStaleWorker,
		"stale worker mutated the reinstalled channel",
	);
	runManager("production", ["--quiet", "--delete-data"]);
	assertDataRemoved("production");
}

function runLegacyManifestTest() {
	console.log("Testing legacy manifest and missing bundled-manager compatibility...");
	const installation = install("production");
	const paths = seedState("production");
	const legacy = {
		schema_version: 1,
		install_nonce: installation.manifest.install_nonce,
		identifier,
		name: appName,
		channel: "production",
		desktop_shortcut: installation.manifest.desktop_shortcut,
		start_menu_shortcut: installation.manifest.start_menu_shortcut,
	};
	writeFileSync(paths.manifest, JSON.stringify(legacy, null, 2) + "\n");
	const previousManagerHash = sha256File(paths.manager);
	const previousNonce = legacy.install_nonce;
	unlinkSync(paths.packagedManager);
	writeFileSync(
		join(paths.app, "Resources", "version.json"),
		JSON.stringify({
			channel: "production",
			identifier,
			name: appName,
			version: updatedVersion,
		}) + "\n",
	);
	runManager("production", ["--refresh-registration", "--quiet"]);
	const refreshed = readManifest("production");
	assert.equal(sha256File(paths.manager), previousManagerHash);
	assert.notEqual(refreshed.install_nonce, previousNonce);
	assert.deepEqual(refreshed.data_path_versions, [1]);
	assertRegistration("production", updatedVersion);
	// Rewrite the original manifest shape to prove uninstall itself remains
	// compatible after the legacy refresh fallback has also been exercised.
	legacy.install_nonce = refreshed.install_nonce;
	writeFileSync(paths.manifest, JSON.stringify(legacy, null, 2) + "\n");
	runManager("production", ["--uninstall", "--quiet"]);
	assertAppOnlyRemoved("production", { manifest: legacy, paths });
	resetChannel("production");
}

function startExclusiveFileHolder(path, readyPath) {
	const script =
		"$stream = [IO.File]::Open(" +
		psLiteral(path) +
		", [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None); " +
		"[IO.File]::WriteAllText(" +
		psLiteral(readyPath) +
		", 'ready'); " +
		"try { Start-Sleep -Seconds 120 } finally { $stream.Dispose() }";
	return spawn(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			encodedPowerShell(script),
		],
		{ stdio: "ignore", windowsHide: true },
	);
}

function stopProcessTree(child) {
	if (!child || !child.pid) return;
	runRaw("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
		timeout: 10_000,
	});
	sleep(300);
}

function runRetryRetentionTest() {
	console.log("Testing retry retention after managed cleanup failure...");
	install("production");
	const paths = seedState("production");
	const readyPath = join(temporaryRoot, "locked-update-ready-" + token);
	const holder = startExclusiveFileHolder(paths.updateScript, readyPath);
	try {
		waitFor(() => pathExists(readyPath), "exclusive update.bat lock", 10_000);
		const result = runRaw(paths.manager, ["--quiet"], {
			cwd: paths.root,
			timeout: 45_000,
		});
		if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;
		assert.equal(
			pathExists(paths.manager),
			true,
			"cleanup failure removed the retry manager",
		);
		assert.equal(
			pathExists(paths.manifest),
			true,
			"cleanup failure removed the retry manifest",
		);
		assert.equal(
			registryExists("production"),
			true,
			"cleanup failure removed the retry Installed Apps entry",
		);
	} finally {
		stopProcessTree(holder);
	}
	runManager("production", ["--quiet"]);
	waitForManagerCleanup("production");
	assert.equal(registryExists("production"), false);
	assert.equal(pathExists(paths.userSentinel), true);
	resetChannel("production");
}

function runUserDataExecutableHijackTest() {
	console.log("Testing app-only cleanup ignores user-data executable names...");
	const installation = install("production");
	const paths = seedState("production", { task: true });
	const fakePowerShell = join(paths.root, "powershell.exe");
	const fakeScheduledTasks = join(paths.root, "schtasks.exe");
	writeFileSync(fakePowerShell, "user data, not an executable\n");
	writeFileSync(fakeScheduledTasks, "user data, not an executable\n");

	runManager("production", ["--quiet"]);
	assertAppOnlyRemoved("production", installation);
	assert.equal(pathExists(fakePowerShell), true);
	assert.equal(pathExists(fakeScheduledTasks), true);
	resetChannel("production");
}

function runDeferredWorkerRetryRetentionTest() {
	console.log("Testing early deferred-worker failure retains retry registration...");
	const installation = install("production");
	const paths = seedState("production");
	const workerPath = join(
		windowsTemporaryDirectory,
		"electrobun-uninstall-" + randomBytes(8).toString("hex") + ".exe",
	);
	const readyPath = join(temporaryRoot, "locked-manifest-ready-" + token);
	copyFileSync(paths.manager, workerPath);
	const holder = startExclusiveFileHolder(paths.manifest, readyPath);
	try {
		waitFor(() => pathExists(readyPath), "exclusive manifest lock", 10_000);
		const result = runRaw(
			workerPath,
			[
				"--cleanup-uninstaller",
				paths.manager,
				paths.manifest,
				installation.manifest.install_nonce,
			],
			{ cwd: windowsTemporaryDirectory, timeout: 45_000 },
		);
		assert.notEqual(result.status, 0, "locked manifest unexpectedly cleaned up");
		assert.equal(pathExists(paths.manager), true);
		assert.equal(pathExists(paths.manifest), true);
		assert.equal(
			registryExists("production"),
			true,
			"early worker failure removed the Installed Apps retry entry",
		);
	} finally {
		stopProcessTree(holder);
	}
	waitFor(() => !pathExists(workerPath), "failed worker self-cleanup", 45_000);
	runManager("production", ["--quiet"]);
	assertAppOnlyRemoved("production", installation);
	resetChannel("production");
}

function runPrivateCleanupLocationSafetyTest() {
	console.log("Testing private cleanup rejects installed/arbitrary manager locations...");
	const installation = install("production");
	const paths = seedState("production");
	const before = captureFixture("production");
	const installedResult = runRaw(
		paths.manager,
		[
			"--cleanup-uninstaller",
			paths.manager,
			paths.manifest,
			installation.manifest.install_nonce,
		],
		{ cwd: paths.root, timeout: 30_000 },
	);
	if (installedResult.error) throw installedResult.error;
	assert.notEqual(installedResult.status, 0);
	assertFixtureUnchanged(
		"production",
		before,
		"installed manager accepted a private cleanup command",
	);
	sleep(2_000);
	assert.equal(pathExists(paths.manager), true, "private command self-deleted manager");
	assert.equal(newCleanupArtifacts().length, 0, "private command scheduled cleanup artifacts");

	const arbitraryManager = join(temporaryRoot, "copied-manager.exe");
	copyFileSync(paths.manager, arbitraryManager);
	const copiedResult = runRaw(
		arbitraryManager,
		[
			"--cleanup-uninstaller",
			paths.manager,
			paths.manifest,
			installation.manifest.install_nonce,
		],
		{ cwd: temporaryRoot, timeout: 30_000 },
	);
	if (copiedResult.error) throw copiedResult.error;
	assert.notEqual(copiedResult.status, 0);
	assert.equal(pathExists(arbitraryManager), true, "arbitrary copy self-deleted");
	assertFixtureUnchanged(
		"production",
		before,
		"arbitrary copied manager mutated the installation",
	);
	unlinkSync(arbitraryManager);
	runManager("production", ["--quiet"]);
	assertAppOnlyRemoved("production", installation);
	resetChannel("production");
}

function runInteractiveTests() {
	console.log("\nInteractive TaskDialog validation enabled.");
	const automated = process.env.ELECTROBUN_WINDOWS_UI_AUTOMATION === "1";
	console.log(
		automated
			? "Native UI Automation will drive and inspect each dialog."
			: "Follow each instruction exactly; the harness verifies the result.",
	);

	let installation = install("production");
	seedState("production");
	let before = captureFixture("production");
	console.log("\n1/4: Close the dialog with its X button.");
	if (automated) {
		automateTaskDialog("production", [], "close");
	} else {
		runManager("production", [], { timeout: 600_000, windowsHide: false });
	}
	assertFixtureUnchanged("production", before, "window close was not Cancel");

	before = captureFixture("production");
	console.log("\n2/4: Click Cancel.");
	if (automated) {
		automateTaskDialog("production", ["--uninstall"], "Cancel");
	} else {
		runManager("production", ["--uninstall"], {
			timeout: 600_000,
			windowsHide: false,
		});
	}
	assertFixtureUnchanged("production", before, "Cancel mutated installation");

	if (automated) {
		console.log("\n2b/4: Press Enter to verify App is the effective default.");
		automateTaskDialog("production", [], "default");
		assertAppOnlyRemoved("production", installation);
		resetChannel("production");
		installation = install("production");
		seedState("production");
	}

	console.log("\n3/4: Click App and Data.");
	if (automated) {
		automateTaskDialog("production", [], "App and Data");
	} else {
		runManager("production", [], { timeout: 600_000, windowsHide: false });
	}
	assertDataRemoved("production");

	installation = install("production");
	seedState("production");
	console.log(
		"\n4/4: Settings will open. Find " +
			appName +
			", click Uninstall, then click App.",
	);
	if (automated) {
		automateInstalledAppsUninstall("production");
	} else {
		spawn("cmd.exe", ["/d", "/c", "start", "", "ms-settings:appsfeatures"], {
			detached: true,
			stdio: "ignore",
			windowsHide: false,
		}).unref();
	}
	waitFor(
		() => !pathExists(fixturePaths("production").manager),
		"Installed Apps interactive uninstall",
		600_000,
	);
	assertAppOnlyRemoved("production", installation);
	resetChannel("production");
	console.log("Interactive TaskDialog validation passed.");
}

function cleanupEverything() {
	for (const channel of ["production", "canary"]) {
		try {
			resetChannel(channel);
		} catch (error) {
			console.error("Warning: fixture channel cleanup failed:", error);
		}
	}
	try {
		removeExactShortcut(unrelatedShortcut, desktopDirectory);
	} catch {}
	assertExactPath(unrelatedRoot, join(localAppData, unrelatedIdentifier), "unrelated cleanup");
	assertExactOrChild(localAppData, unrelatedRoot, "unrelated cleanup");
	rmSync(unrelatedRoot, { force: true, recursive: true });
	try {
		rmdirSync(identifierRoot);
	} catch {}
	assertExactOrChild(tmpdir(), temporaryRoot, "temporary cleanup");
	rmSync(temporaryRoot, { force: true, recursive: true });
}

try {
	assert.ok(
		localAppData.length > 3 && normalizePath(localAppData) !== normalizePath("\\"),
		"LOCALAPPDATA resolved to an unsafe path",
	);
	assertExactOrChild(localAppData, identifierRoot, "identifier fixture root");
	assert.equal(pathExists(identifierRoot), false, "fixture identifier already exists");
	assert.equal(pathExists(unrelatedRoot), false, "unrelated fixture identifier exists");
	assert.equal(pathExists(unrelatedShortcut), false, "fixture shortcut collision");
	for (const channel of ["production", "canary"]) {
		assert.equal(registryExists(channel), false, "fixture registry collision");
		assert.equal(taskExists(channel), false, "fixture task collision");
		assert.equal(pathExists(expectedDesktopShortcut(channel)), false);
		assert.equal(pathExists(expectedStartShortcut(channel)), false);
	}
	fixtureCleanupArmed = true;

	const zig = findZig();
	console.log("Using Zig " + run(zig, ["version"]).stdout.trim());
	if (process.env.ELECTROBUN_WINDOWS_SKIP_BUILDS !== "1") {
		runZigBuild(zig, extractorRoot, ["test"]);
		runZigBuild(zig, extractorRoot, ["-Doptimize=" + optimize]);
		runZigBuild(zig, launcherRoot, ["test"]);
		runZigBuild(zig, launcherRoot, ["-Doptimize=" + optimize]);
	} else {
		console.log("Using independently verified existing Windows binaries");
	}
	const extractor = join(extractorRoot, "zig-out", "bin", "extractor.exe");
	const launcher = join(launcherRoot, "zig-out", "bin", "launcher.exe");
	const zigZstd = join(packageRoot, "vendors", "zig-zstd", "zig-zstd.exe");
	for (const path of [extractor, launcher, zigZstd]) {
		assert.equal(pathExists(path), true, "required test binary is missing: " + path);
	}

	buildSetup("production", extractor, launcher, zigZstd);
	buildSetup("canary", extractor, launcher, zigZstd);
	if (focusedTest === "update-refresh") {
		runUpdateRefreshTest(extractor);
	} else if (focusedTest === "interactive") {
		runInteractiveTests();
	} else {
		runStrictCliAndCleanupTests();
		runChannelIsolationTests();
		runDamagedAppTest();
		runLocationAndJunctionSafetyTests();
		runLauncherDelegationTest();
		runUpdateRefreshTest(extractor);
		runNonceRaceTest();
		runLegacyManifestTest();
		runRetryRetentionTest();
		runUserDataExecutableHijackTest();
		runDeferredWorkerRetryRetentionTest();
		runPrivateCleanupLocationSafetyTest();
	}
	const interactive =
		process.argv.includes("--interactive") ||
		process.env.ELECTROBUN_WINDOWS_INTERACTIVE === "1";
	if (interactive && focusedTest !== "interactive") runInteractiveTests();
	assertNoNewCleanupArtifacts();

	console.log(
		(focusedTest === "update-refresh"
			? "Windows uninstaller focused update-refresh integration passed"
			: focusedTest === "interactive"
				? "Windows uninstaller focused interactive integration passed"
			: "Windows uninstaller integration passed (strict CLI, thin manager, Installed Apps, shortcuts, app/data cleanup, isolation, damage, path safety, delegation, update refresh, nonce race, legacy manifest, retry retention, user-data executable isolation, deferred-worker retry, private cleanup location safety)") +
			(interactive ? " + interactive TaskDialog" : ""),
	);
} finally {
	if (fixtureCleanupArmed) {
		cleanupEverything();
	} else {
		assertExactOrChild(tmpdir(), temporaryRoot, "unarmed temporary cleanup");
		rmSync(temporaryRoot, { force: true, recursive: true });
	}
}
