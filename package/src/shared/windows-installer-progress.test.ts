import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const extractorRoot = join(import.meta.dirname, "../extractor");
const extractorMain = readFileSync(join(extractorRoot, "main.zig"), "utf8");
const extractorBuild = readFileSync(join(extractorRoot, "build.zig"), "utf8");
const windowsBridge = readFileSync(
	join(extractorRoot, "windows_uninstall_prompt.c"),
	"utf8",
);
const windowsManifest = readFileSync(
	join(extractorRoot, "extractor.manifest"),
	"utf8",
);
const macosBridge = readFileSync(
	join(extractorRoot, "macos_uninstall_prompt.m"),
	"utf8",
);
const linuxPrompt = readFileSync(
	join(extractorRoot, "linux_uninstall_prompt.zig"),
	"utf8",
);
const windowsIntegration = readFileSync(
	join(import.meta.dirname, "../../scripts/test-windows-uninstaller.mjs"),
	"utf8",
);
const macosIntegration = readFileSync(
	join(import.meta.dirname, "../../scripts/test-macos-uninstaller.mjs"),
	"utf8",
);
const previewScript = readFileSync(
	join(import.meta.dirname, "../../scripts/preview-installer-ui.mjs"),
	"utf8",
);
const hutchConfig = readFileSync(
	join(import.meta.dirname, "../../hutch.config.ts"),
	"utf8",
);

function sourceBetween(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	expect(startIndex).toBeGreaterThanOrEqual(0);
	expect(endIndex).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
}

describe("Windows installer native progress UI contract", () => {
	test("ships as a GUI executable with an explicit diagnostic-console opt-in", () => {
		expect(extractorBuild).toContain('"windows-console"');
		expect(extractorBuild).toMatch(/windows_console[\s\S]*orelse false/);
		expect(extractorBuild).toContain(
			"exe.subsystem = if (windows_console) .Console else .Windows;",
		);
		expect(extractorBuild).toContain('b.path("windows_uninstall_prompt.c")');
		expect(extractorBuild).toContain('linkSystemLibrary("comctl32"');
		expect(windowsManifest).toContain("Microsoft.Windows.Common-Controls");
		expect(windowsManifest).toContain('version="6.0.0.0"');
		expect(windowsManifest).not.toContain("Electrobun");
	});

	test("exposes a native, threaded TaskDialog lifecycle", () => {
		for (const symbol of [
			"electrobun_windows_installer_ui_start",
			"electrobun_windows_installer_ui_set_phase",
			"electrobun_windows_installer_ui_set_progress",
			"electrobun_windows_installer_ui_complete",
			"electrobun_windows_installer_ui_close",
		]) {
			expect(windowsBridge).toContain(symbol);
			expect(extractorMain).toContain(symbol);
		}

		expect(windowsBridge).toContain("TaskDialogIndirect(");
		expect(windowsBridge).toMatch(/CreateThread|_beginthreadex/);
		expect(windowsBridge).toContain("WaitForSingleObject(");
		expect(windowsBridge).toContain("TDF_SHOW_MARQUEE_PROGRESS_BAR");
		expect(windowsBridge).toContain("TDM_SET_PROGRESS_BAR_MARQUEE");
		expect(windowsBridge).toContain("TDM_SET_PROGRESS_BAR_POS");
		expect(windowsBridge).toContain("TDM_SET_ELEMENT_TEXT");
		expect(windowsBridge).toContain('L" Setup"');
		expect(windowsBridge).toContain('L"Installation complete"');
		expect(windowsBridge).toContain('L"Installation failed"');
		expect(windowsBridge).toContain('L"Close"');
		expect(windowsBridge).toContain("ELECTROBUN_INSTALLER_UI_AUTOCLOSE");
	});

	test("models ordered phases and terminal success and failure", () => {
		const phases = sourceBetween(
			extractorMain,
			"const InstallPhase = enum",
			"const InstallProgress = struct",
		);
		let previous = -1;
		for (const phase of [
			"preparing",
			"decompressing",
			"extracting",
			"installing_files",
			"integrating",
			"completed",
			"failed",
		]) {
			const position = phases.indexOf(phase);
			expect(position).toBeGreaterThan(previous);
			previous = position;
		}

		const progressIndicator = sourceBetween(
			extractorMain,
			"const ProgressIndicator = struct",
			"fn linuxAdjacentMetadataPath",
		);
		expect(progressIndicator).toContain("fn update(");
		expect(progressIndicator).toContain("fn complete(");
		expect(progressIndicator).toContain(".failed");
		expect(progressIndicator).toContain(
			"electrobun_windows_installer_ui_set_phase",
		);
		expect(progressIndicator).toContain(
			"electrobun_windows_installer_ui_set_progress",
		);
		expect(progressIndicator).toContain(
			"electrobun_windows_installer_ui_complete",
		);
		expect(progressIndicator).toContain(
			"electrobun_windows_installer_ui_close",
		);
	});

	test("shows a native terminal error even when package metadata is damaged", () => {
		expect(extractorMain).toContain("fn presentGenericInstallerFailure(");
		expect(extractorMain).toContain("g_installer_failure_presented");
		const platformDispatch = sourceBetween(
			extractorMain,
			"// Platform-specific extraction",
			"fn isStableChannel",
		);
		expect(platformDispatch).toContain(
			"const extracted = extractFromSelf(allocator) catch",
		);
		expect(platformDispatch).toContain(
			"The installer package is invalid or could not be read.",
		);
		expect(platformDispatch).toContain(
			"The installer metadata is invalid.",
		);
	});

	test("never exposes framework branding in developer-facing installer UI", () => {
		const progressUi = sourceBetween(
			extractorMain,
			"const ProgressIndicator = struct",
			"fn linuxAdjacentMetadataPath",
		);
		expect(progressUi).not.toContain('"Electrobun Installer"');
		expect(progressUi).not.toContain('"Electrobun Installer Preview"');
		expect(progressUi).not.toContain('"Electrobun Uninstaller Preview"');
		expect(progressUi).toContain('"{s} Setup"');
		expect(extractorMain).not.toContain(
			'appendSlice(allocator, "Electrobun App")',
		);
		expect(extractorMain).not.toContain(
			'std.debug.print("Electrobun self-extractor',
		);
	});
});

describe("Windows adjacent installer streaming contract", () => {
	test("shares adjacent streaming and progress reporting with Linux", () => {
		const extractionDispatch = sourceBetween(
			extractorMain,
			"fn extractFromSelf",
			"const EmbeddedMetadataSlice",
		);
		expect(extractionDispatch.match(/extractAdjacentArchive\(/g)?.length).toBe(2);
		expect(extractionDispatch).toMatch(
			/if \(builtin\.os\.tag == \.linux\)[\s\S]*extractAdjacentArchive\(/,
		);
		expect(extractionDispatch).toMatch(
			/if \(builtin\.os\.tag == \.windows\)[\s\S]*extractAdjacentArchive\(/,
		);

		const streaming = sourceBetween(
			extractorMain,
			"fn streamZstdToTar",
			"fn extractTarFile",
		);
		expect(streaming).toContain("progress: *ProgressIndicator");
		expect(streaming).toContain("progress.update(");
		expect(streaming).not.toContain("builtin.os.tag == .windows");
	});

	test("does not materialize the adjacent compressed archive in memory", () => {
		const adjacentInstall = sourceBetween(
			extractorMain,
			"fn extractAdjacentArchive",
			"fn extractFromSelf",
		);
		expect(adjacentInstall).not.toContain(
			"readFileAlloc(g_io, archive_path, allocator, .unlimited)",
		);
		expect(adjacentInstall).toContain(".{ .file = archive_path }");
	});

	test("commits a complete retained tar and cleans partial output", () => {
		const streaming = sourceBetween(
			extractorMain,
			"fn streamZstdToTar",
			"fn extractTarFile",
		);
		expect(streaming).toContain("errdefer");
		expect(streaming).toContain("sync(");
		expect(streaming).toContain("zstd.Decompress");
		expect(streaming).not.toContain("allocRemaining(");

		const fileInstall = sourceBetween(
			extractorMain,
			"const InstallArchiveSource",
			"fn extractTar(",
		);
		expect(fileInstall).toContain('"{s}.partial"');
		expect(fileInstall).toContain("errdefer");
		expect(fileInstall).toContain("streamZstdToTar(");
		expect(fileInstall).toContain("extractTarFile(");
		expect(fileInstall).toContain("publishExtractionState(");

		const rollbackArmed = fileInstall.indexOf(
			"var app_rollback_armed = true;",
		);
		const statePublished = fileInstall.indexOf(
			"try publishExtractionState(",
		);
		const rollbackDisarmed = fileInstall.indexOf(
			"app_rollback_armed = false;",
		);
		const integrationStarted = fileInstall.indexOf(
			"progress.update(.integrating",
		);
		expect(rollbackArmed).toBeGreaterThanOrEqual(0);
		expect(statePublished).toBeGreaterThan(rollbackArmed);
		expect(rollbackDisarmed).toBeGreaterThan(statePublished);
		expect(integrationStarted).toBeGreaterThan(rollbackDisarmed);

		const appRollback = sourceBetween(
			fileInstall,
			"defer if (app_rollback_armed",
			"progress.update(.installing_files",
		);
		expect(appRollback).toContain("deleteTree(g_io, app_dir)");
		expect(appRollback).toContain(
			"rename(previous_app_dir, std.Io.Dir.cwd(), app_dir, g_io)",
		);

		expect(windowsIntegration).toContain(
			"retained updater tar differs from the adjacent installer payload",
		);
		expect(windowsIntegration).toContain(
			"completed install retained a partial updater tar",
		);
		expect(windowsIntegration).toContain(
			'ELECTROBUN_INSTALLER_UI_AUTOCLOSE: "1"',
		);
	});
});

describe("macOS installer native progress UI contract", () => {
	test("uses the shared lifecycle through a modeless AppKit panel", () => {
		const installerAdapter = sourceBetween(
			macosBridge,
			"@interface ElectrobunInstallerProgressUI",
			"enum {",
		);
		for (const symbol of [
			"electrobun_macos_installer_ui_start",
			"electrobun_macos_installer_ui_set_phase",
			"electrobun_macos_installer_ui_set_progress",
			"electrobun_macos_installer_ui_complete",
			"electrobun_macos_installer_ui_close",
		]) {
			expect(macosBridge).toContain(symbol);
			expect(extractorMain).toContain(symbol);
		}
		expect(installerAdapter).toContain("NSPanel");
		expect(installerAdapter).toContain("NSProgressIndicator");
		expect(installerAdapter).toContain("indeterminate = YES");
		expect(installerAdapter).toContain("indeterminate = NO");
		expect(installerAdapter).toContain("nextEventMatchingMask");
		expect(installerAdapter).not.toContain("runModal");
	});

	test("shows terminal success or failure and supports deterministic QA", () => {
		expect(macosBridge).toContain('@"Installation complete"');
		expect(macosBridge).toContain('@"Installation failed"');
		expect(macosBridge).toContain('buttonWithTitle:@"Close"');
		expect(macosBridge).toContain("windowShouldClose:");
		expect(macosBridge).toContain("if (!self.terminal)");
		expect(macosBridge).toContain("ELECTROBUN_INSTALLER_UI_AUTOCLOSE");
		expect(macosIntegration).toContain(
			'ELECTROBUN_INSTALLER_UI_AUTOCLOSE: "1"',
		);
	});

	test("preserves the existing native uninstall prompt", () => {
		expect(macosBridge).toContain("electrobun_show_uninstall_prompt");
		expect(macosBridge).toContain('alert.messageText = [NSString stringWithFormat:@"Uninstall %@?"');
		expect(macosBridge).toContain('[alert addButtonWithTitle:@"App"]');
		expect(macosBridge).toContain('[alert addButtonWithTitle:@"App and Data"]');
		expect(macosBridge).toContain('[alert addButtonWithTitle:@"Cancel"]');
	});
});

describe("cross-platform installer UI preview contract", () => {
	test("dispatches before payload discovery and animates the shared phases", () => {
		const mainStart = sourceBetween(
			extractorMain,
			"pub fn main(",
			"// Installed uninstallers are copies of this extractor",
		);
		expect(mainStart).toContain("ELECTROBUN_INSTALLER_UI_PREVIEW");
		expect(mainStart).toContain("runInstallerUiPreview(");

		const preview = sourceBetween(
			extractorMain,
			"fn runInstallerUiPreview",
			"pub fn main(",
		);
		for (const phase of [
			"preparing",
			"decompressing",
			"extracting",
			"installing_files",
			"integrating",
		]) {
			expect(preview).toContain(`.${phase}`);
		}
		expect(preview).toContain('"all"');
		expect(preview).toContain('"error"');
		expect(preview).toContain("progress.update(");
		expect(preview).toContain("progress.complete(");
	});

	test("previews the real uninstall chooser with explicit non-mutating copy", () => {
		const safeCopy = "UI preview only; no files will be removed.";
		expect(windowsBridge).toContain(
			"electrobun_preview_windows_uninstall_prompt",
		);
		expect(windowsBridge).toContain(safeCopy);
		expect(macosBridge).toContain("electrobun_preview_macos_uninstall_prompt");
		expect(macosBridge).toContain(safeCopy);
		expect(linuxPrompt).toContain("pub fn showPreview(");
		expect(linuxPrompt).toContain(safeCopy);
		expect(extractorMain).toContain(
			"electrobun_preview_windows_uninstall_prompt",
		);
		expect(extractorMain).toContain(
			"electrobun_preview_macos_uninstall_prompt",
		);
		expect(extractorMain).toContain("linux_uninstall_prompt.showPreview(");
	});

	test("offers success/all and error preview commands on every host", () => {
		expect(extractorBuild).toContain('"installer-ui-preview"');
		expect(extractorBuild).toContain('"installer-ui-preview-error"');
		expect(extractorBuild).toContain('"all"');
		expect(extractorBuild).toContain('"error"');
		expect(previewScript).toContain('"installer-ui-preview"');
		expect(previewScript).toContain('"installer-ui-preview-error"');
		expect(previewScript).toContain("without reading,");
		expect(hutchConfig).toContain('"preview:installer-ui"');
		expect(hutchConfig).toContain('"preview:installer-ui:error"');
	});
});
