/**
 * NSIS .exe installer generator for Electrobun Windows builds.
 *
 * Produces a production-ready installer with:
 *  - DPI awareness (PerMonitorV2)
 *  - Silent (/S), passive (/P), update (/UPDATE), no-shortcut (/NS) modes
 *  - Version comparison and upgrade/reinstall detection
 *  - URL protocol registration (config.app.urlSchemes)
 *  - Per-user (default) or per-machine installation
 *  - Add/Remove Programs registry entries with estimated size
 *  - Desktop + Start Menu shortcuts
 *  - Uninstaller with optional app-data deletion
 *  - LZMA solid compression
 */

import { join } from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { spawnSync } from "child_process";

// ── NSIS template ─────────────────────────────────────────────────────────────

/**
 * The raw NSIS script template. Placeholders use {{UPPER_SNAKE_CASE}} syntax.
 *
 * Variables injected by renderNsisTemplate():
 *   {{APP_NAME}}             Display name (may contain spaces)
 *   {{APP_NAME_SANITIZED}}   No-space name used for registry paths
 *   {{APP_VERSION}}          e.g. "1.2.3"
 *   {{APP_VERSION_4SEG}}     e.g. "1.2.3.0" (required by VIProductVersion)
 *   {{APP_IDENTIFIER}}       e.g. "com.example.myapp"
 *   {{APP_PUBLISHER}}        Publisher / company name
 *   {{APP_DESCRIPTION}}      Short description string
 *   {{HOMEPAGE}}             Homepage URL (may be empty)
 *   {{OUTPUT_FILE}}          Absolute path for the compiled installer .exe
 *   {{BUNDLE_DIR}}           Absolute path to the extracted app bundle folder
 *   {{INSTALL_DIR}}          Default install directory NSIS expression
 *   {{INSTALL_MODE}}         "currentUser" | "perMachine"
 *   {{ALLOW_DOWNGRADES}}     "true" | "false"
 *   {{DESKTOP_SHORTCUT}}     "true" | "false"
 *   {{START_MENU_FOLDER}}    Start menu folder name
 *   {{MUI_ICON_LINE}}        !define MUI_ICON "…" or empty string
 *   {{MUI_UNICON_LINE}}      !define MUI_UNICON "…" or empty string
 *   {{URL_PROTOCOLS_INSTALL}}  NSIS WriteRegStr block for URL protocols
 *   {{URL_PROTOCOLS_UNINSTALL}} NSIS DeleteRegKey block for URL protocols
 *   {{APPDATA_DELETE_SECTION}}  NSIS block to delete app data dirs on uninstall
 *   {{LEGACY_DETECT_BLOCK}}     NSIS block in .onInit to detect legacy extractor installs
 *   {{LEGACY_CLEANUP_BLOCK}}    NSIS block in Install section to clean up legacy installs
 *   {{WEBVIEW2_INSTALL_SECTION}} NSIS block to download and install WebView2 if missing
 */
const NSIS_TEMPLATE = `Unicode true
ManifestDPIAware true
; PerMonitorV2 DPI awareness (Windows 10 1607+; ignored on older systems)
ManifestDPIAwareness PerMonitorV2

SetCompressor /SOLID lzma
SetCompressorDictSize 32

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "nsDialogs.nsh"

; ── App metadata ─────────────────────────────────────────────────────────────
!define APP_NAME        "{{APP_NAME}}"
!define APP_NAME_SAN    "{{APP_NAME_SANITIZED}}"
!define APP_VERSION     "{{APP_VERSION}}"
!define APP_IDENTIFIER  "{{APP_IDENTIFIER}}"
!define APP_PUBLISHER   "{{APP_PUBLISHER}}"
!define INSTALL_MODE    "{{INSTALL_MODE}}"
!define ALLOW_DOWNGRADES {{ALLOW_DOWNGRADES}}

; Registry keys
!define REG_UNINSTALL "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$\{APP_IDENTIFIER}"
!define REG_APP       "Software\\$\{APP_PUBLISHER}\\$\{APP_NAME_SAN}"

; ── MUI2 appearance ───────────────────────────────────────────────────────────
{{MUI_ICON_LINE}}
{{MUI_UNICON_LINE}}
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_NOAUTOCLOSE

; ── General ───────────────────────────────────────────────────────────────────
Name "$\{APP_NAME} $\{APP_VERSION}"
OutFile "{{OUTPUT_FILE}}"

!if "$\{INSTALL_MODE}" == "perMachine"
  RequestExecutionLevel admin
  InstallDir "$PROGRAMFILES64\\$\{APP_NAME}"
!else
  RequestExecutionLevel user
  InstallDir "{{INSTALL_DIR}}"
!endif

InstallDirRegKey HKCU "$\{REG_APP}" "InstallLocation"

; ── Version info (embedded in .exe PE header) ─────────────────────────────────
VIProductVersion "{{APP_VERSION_4SEG}}"
VIAddVersionKey "ProductName"     "$\{APP_NAME}"
VIAddVersionKey "ProductVersion"  "$\{APP_VERSION}"
VIAddVersionKey "CompanyName"     "$\{APP_PUBLISHER}"
VIAddVersionKey "FileDescription" "$\{APP_NAME} Installer"
VIAddVersionKey "FileVersion"     "$\{APP_VERSION}"
VIAddVersionKey "LegalCopyright"  "$\{APP_PUBLISHER}"

; ── Runtime variables ─────────────────────────────────────────────────────────
Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var ReinstallAction     ; 1=reinstall/upgrade  2=uninstall
Var InstalledVersion
Var VersionCmp          ; 0=same 1=newer 2=downgrade
Var LegacyFound         ; 1 if a legacy extractor install was detected

; ── Installer pages ───────────────────────────────────────────────────────────
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME

; Custom reinstall/upgrade page (shown only when an existing install is found)
Page custom PageReinstall PageLeaveReinstall

!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_DIRECTORY

!insertmacro MUI_PAGE_INSTFILES

; Finish page — offer to launch the app
!define MUI_FINISHPAGE_RUN          "$INSTDIR\\bin\\launcher.exe"
!define MUI_FINISHPAGE_RUN_TEXT     "Launch $\{APP_NAME}"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

; ── Uninstaller pages ─────────────────────────────────────────────────────────
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState

!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.AddDeleteDataCheckbox
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ReadDeleteDataCheckbox
!define MUI_PAGE_CUSTOMFUNCTION_PRE  un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

!insertmacro MUI_UNPAGE_INSTFILES

; ── Language ──────────────────────────────────────────────────────────────────
!insertmacro MUI_LANGUAGE "English"

; ── .onInit ───────────────────────────────────────────────────────────────────
Function .onInit
  ; Parse command-line flags
  $\{GetOptions} $CMDLINE "/P" $PassiveMode
  $\{IfNot} $\{Errors}
    StrCpy $PassiveMode 1
  $\{EndIf}

  $\{GetOptions} $CMDLINE "/NS" $NoShortcutMode
  $\{IfNot} $\{Errors}
    StrCpy $NoShortcutMode 1
  $\{EndIf}

  $\{GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  $\{IfNot} $\{Errors}
    StrCpy $UpdateMode 1
  $\{EndIf}

  ; Restore previous install location (if user has installed before)
  Call RestorePreviousInstallLocation

  ; Detect legacy extractor-based install (flag only — cleanup after install succeeds)
{{LEGACY_DETECT_BLOCK}}

  !if "$\{INSTALL_MODE}" == "perMachine"
    SetShellVarContext all
    SetRegView 64
  !else
    SetShellVarContext current
  !endif
FunctionEnd

; ── Reinstall detection page ──────────────────────────────────────────────────
Function PageReinstall
  ; Check for an existing installation
  ReadRegStr $0 HKCU "$\{REG_UNINSTALL}" "DisplayVersion"
  ; Also check HKLM for per-machine installs
  $\{If} $0 == ""
    ReadRegStr $0 HKLM "$\{REG_UNINSTALL}" "DisplayVersion"
  $\{EndIf}
  $\{IfThen} $0 == "" $\{|} Abort $\{|}  ; No existing install — skip this page

  StrCpy $InstalledVersion $0

  ; Compare versions: 0=same, 1=new>installed (upgrade), 2=new<installed (downgrade)
  $\{VersionCompare} "$\{APP_VERSION}" "$InstalledVersion" $VersionCmp

  ; In update mode, always overlay-install (skip this page)
  $\{If} $UpdateMode = 1
    Abort
  $\{EndIf}

  ; In passive/silent mode, handle automatically
  $\{If} $PassiveMode = 1
  $\{OrIf} $\{Silent}
    ; Upgrading: proceed (will overwrite files)
    $\{If} $VersionCmp = 1
      Abort
    $\{EndIf}
    ; Downgrading and not allowed: abort
    !if "$\{ALLOW_DOWNGRADES}" == "false"
      $\{If} $VersionCmp = 2
        MessageBox MB_ICONSTOP "A newer version of $\{APP_NAME} ($InstalledVersion) is already installed.$\\nDowngrades are not allowed." /SD IDOK
        Abort
      $\{EndIf}
    !endif
    ; Same version or allowed downgrade: reinstall
    Abort
  $\{EndIf}

  ; ── Show reinstall/upgrade dialog ─────────────────────────────────────────
  nsDialogs::Create 1018
  Pop $R0
  $\{If} $R0 == error
    Abort
  $\{EndIf}

  ; Determine dialog text based on version comparison
  $\{If} $VersionCmp = 0
    $\{NSD_CreateLabel} 0 0 100% 40u "Version $InstalledVersion of $\{APP_NAME} is already installed.$\\n$\\nChoose an option below:"
    Pop $R1
    $\{NSD_CreateRadioButton} 20u 50u -20u 10u "Reinstall (overwrite existing files)"
    Pop $R2
    $\{NSD_CreateRadioButton} 20u 65u -20u 10u "Uninstall $\{APP_NAME}"
    Pop $R3
  $\{ElseIf} $VersionCmp = 1
    $\{NSD_CreateLabel} 0 0 100% 40u "Version $InstalledVersion of $\{APP_NAME} is installed.$\\nYou are installing version $\{APP_VERSION} (upgrade).$\\n$\\nChoose an option below:"
    Pop $R1
    $\{NSD_CreateRadioButton} 20u 50u -20u 10u "Upgrade (recommended)"
    Pop $R2
    $\{NSD_CreateRadioButton} 20u 65u -20u 10u "Keep existing version (cancel)"
    Pop $R3
  $\{Else}
    ; Downgrading
    !if "$\{ALLOW_DOWNGRADES}" == "false"
      MessageBox MB_ICONSTOP "A newer version of $\{APP_NAME} ($InstalledVersion) is already installed.$\\nDowngrades are not allowed." /SD IDOK
      Abort
    !endif
    $\{NSD_CreateLabel} 0 0 100% 40u "Version $InstalledVersion of $\{APP_NAME} is installed.$\\nYou are installing an older version ($\{APP_VERSION}).$\\n$\\nDowngrading:"
    Pop $R1
    $\{NSD_CreateRadioButton} 20u 50u -20u 10u "Downgrade (uninstall current, install older)"
    Pop $R2
    $\{NSD_CreateRadioButton} 20u 65u -20u 10u "Cancel"
    Pop $R3
  $\{EndIf}

  SendMessage $R2 $\{BM_SETCHECK} $\{BST_CHECKED} 0  ; default: first option
  $\{NSD_SetFocus} $R2
  nsDialogs::Show
FunctionEnd

Function PageLeaveReinstall
  $\{NSD_GetState} $R2 $0

  ; If the first radio button is checked — proceed with install/reinstall/upgrade
  $\{If} $0 = $\{BST_CHECKED}
    StrCpy $ReinstallAction 1
    ; Uninstall the existing version first (for upgrade/downgrade/reinstall)
    ReadRegStr $R1 HKCU "$\{REG_UNINSTALL}" "UninstallString"
    $\{If} $R1 == ""
      ReadRegStr $R1 HKLM "$\{REG_UNINSTALL}" "UninstallString"
    $\{EndIf}
    $\{If} $R1 != ""
      HideWindow
      ExecWait '"$R1" /S _?=$INSTDIR' $0
      BringToFront
    $\{EndIf}
  $\{Else}
    ; Second option: cancel or uninstall only
    $\{If} $VersionCmp = 0
      ; Uninstall only
      ReadRegStr $R1 HKCU "$\{REG_UNINSTALL}" "UninstallString"
      $\{If} $R1 == ""
        ReadRegStr $R1 HKLM "$\{REG_UNINSTALL}" "UninstallString"
      $\{EndIf}
      $\{If} $R1 != ""
        HideWindow
        ExecWait '"$R1" /S _?=$INSTDIR' $0
        BringToFront
      $\{EndIf}
    $\{EndIf}
    Abort  ; Cancel the install
  $\{EndIf}
FunctionEnd

; ── Install section ───────────────────────────────────────────────────────────
Section "Install" SecInstall
  SectionIn RO  ; Required — cannot be deselected

  ; Set working output path to install dir
  SetOutPath "$INSTDIR"

  ; Copy all files from the extracted app bundle
  File /r "{{BUNDLE_DIR}}\\*.*"

  ; ── WebView2 runtime installation (if needed) ────────────────────────────
{{WEBVIEW2_INSTALL_SECTION}}

  ; Write uninstaller
  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  ; Save install location to registry (used by InstallDirRegKey on re-run)
  WriteRegStr HKCU "$\{REG_APP}" "InstallLocation" "$INSTDIR"

  ; ── Add/Remove Programs ────────────────────────────────────────────────────
  WriteRegStr   HKCU "$\{REG_UNINSTALL}" "DisplayName"          "$\{APP_NAME}"
  WriteRegStr   HKCU "$\{REG_UNINSTALL}" "DisplayVersion"       "$\{APP_VERSION}"
  WriteRegStr   HKCU "$\{REG_UNINSTALL}" "Publisher"            "$\{APP_PUBLISHER}"
  WriteRegStr   HKCU "$\{REG_UNINSTALL}" "InstallLocation"      "$INSTDIR"
  WriteRegStr   HKCU "$\{REG_UNINSTALL}" "UninstallString"      '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr   HKCU "$\{REG_UNINSTALL}" "QuietUninstallString" '"$INSTDIR\\Uninstall.exe" /S'
  WriteRegStr   HKCU "$\{REG_UNINSTALL}" "DisplayIcon"          "$INSTDIR\\bin\\launcher.exe"
  WriteRegDWORD HKCU "$\{REG_UNINSTALL}" "NoModify"             1
  WriteRegDWORD HKCU "$\{REG_UNINSTALL}" "NoRepair"             1

  ; ── Estimated install size ─────────────────────────────────────────────────
  $\{GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "$\{REG_UNINSTALL}" "EstimatedSize" "$0"

  ; ── Shortcuts (skip if /NS was passed) ────────────────────────────────────
  $\{If} $NoShortcutMode != 1
  $\{AndIf} $UpdateMode != 1
    CreateDirectory "$SMPROGRAMS\\{{START_MENU_FOLDER}}"
    CreateShortcut  "$SMPROGRAMS\\{{START_MENU_FOLDER}}\\$\{APP_NAME}.lnk" \\
                    "$INSTDIR\\bin\\launcher.exe" "" \\
                    "$INSTDIR\\bin\\launcher.exe" 0 \\
                    SW_SHOWNORMAL "" "{{APP_DESCRIPTION}}"

    !if "{{DESKTOP_SHORTCUT}}" == "true"
      CreateShortcut "$DESKTOP\\$\{APP_NAME}.lnk" \\
                     "$INSTDIR\\bin\\launcher.exe" "" \\
                     "$INSTDIR\\bin\\launcher.exe" 0 \\
                     SW_SHOWNORMAL "" "{{APP_DESCRIPTION}}"
    !endif
  $\{EndIf}

  ; ── URL protocol registration ──────────────────────────────────────────────
{{URL_PROTOCOLS_INSTALL}}

  ; ── Legacy migration cleanup (only after successful install) ───────────────
{{LEGACY_CLEANUP_BLOCK}}

  ; ── Auto-close in passive/silent/update mode ──────────────────────────────
  $\{If} $PassiveMode = 1
  $\{OrIf} $\{Silent}
    SetAutoClose true
  $\{EndIf}
SectionEnd

; ── Post-install: optionally launch app ───────────────────────────────────────
Function .onInstSuccess
  $\{If} $PassiveMode = 1
  $\{OrIf} $\{Silent}
    $\{GetOptions} $CMDLINE "/R" $R0
    $\{IfNot} $\{Errors}
      Exec '"$INSTDIR\\bin\\launcher.exe"'
    $\{EndIf}
  $\{EndIf}
FunctionEnd

; ── Uninstaller ───────────────────────────────────────────────────────────────
Function un.onInit
  !if "$\{INSTALL_MODE}" == "perMachine"
    SetShellVarContext all
    SetRegView 64
  !else
    SetShellVarContext current
  !endif

  $\{GetOptions} $CMDLINE "/P" $PassiveMode
  $\{IfNot} $\{Errors}
    StrCpy $PassiveMode 1
  $\{EndIf}

  $\{GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  $\{IfNot} $\{Errors}
    StrCpy $UpdateMode 1
  $\{EndIf}
FunctionEnd

; Add "Delete app data" checkbox to the uninstall confirmation page
Function un.AddDeleteDataCheckbox
  FindWindow $R0 "#32770" "" $HWNDPARENT
  $\{NSD_CreateCheckbox} 0 120u 100% 12u "Also delete application data"
  Pop $DeleteAppDataCheckbox
FunctionEnd

Function un.ReadDeleteDataCheckbox
  $\{NSD_GetState} $DeleteAppDataCheckbox $DeleteAppDataCheckboxState
FunctionEnd

Function un.SkipIfPassive
  $\{IfThen} $PassiveMode = 1 $\{|} Abort $\{|}
FunctionEnd

Section "Uninstall"
  ; Remove files
  RMDir /r "$INSTDIR\\bin"
  RMDir /r "$INSTDIR\\Resources"
  RMDir /r "$INSTDIR\\lib"
  Delete    "$INSTDIR\\Info.plist"
  Delete    "$INSTDIR\\Uninstall.exe"
  RMDir     "$INSTDIR"

  ; Remove shortcuts (skip if this is an update)
  $\{If} $UpdateMode != 1
    Delete "$SMPROGRAMS\\{{START_MENU_FOLDER}}\\$\{APP_NAME}.lnk"
    RMDir  "$SMPROGRAMS\\{{START_MENU_FOLDER}}"
    Delete "$DESKTOP\\$\{APP_NAME}.lnk"
  $\{EndIf}

  ; Remove URL protocols
{{URL_PROTOCOLS_UNINSTALL}}

  ; Remove registry entries
  DeleteRegKey HKCU "$\{REG_UNINSTALL}"
  DeleteRegKey HKCU "$\{REG_APP}"

  ; Remove app data (only when checkbox checked and NOT an update)
  $\{If} $DeleteAppDataCheckboxState = 1
  $\{AndIf} $UpdateMode != 1
{{APPDATA_DELETE_SECTION}}
  $\{EndIf}

  $\{If} $PassiveMode = 1
  $\{OrIf} $UpdateMode = 1
    SetAutoClose true
  $\{EndIf}
SectionEnd

; ── Helpers ───────────────────────────────────────────────────────────────────
Function RestorePreviousInstallLocation
  ReadRegStr $R0 HKCU "$\{REG_APP}" "InstallLocation"
  $\{If} $R0 != ""
    StrCpy $INSTDIR $R0
  $\{EndIf}
FunctionEnd

Function SkipIfPassive
  $\{IfThen} $PassiveMode = 1 $\{|} Abort $\{|}
FunctionEnd
`;

// ── Helper functions ──────────────────────────────────────────────────────────

/**
 * Escape a string for safe use inside an NSIS double-quoted string.
 * Handles $, ", \, `, !, newlines.
 */
export function escapeNsisString(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '$\\"')
		.replace(/\$/g, "$$")
		.replace(/`/g, "$\\`")
		.replace(/!/g, "$\\!")
		.replace(/\n/g, "")
		.replace(/\r/g, "");
}

/**
 * Normalize a semver string to X.Y.Z.W format required by VIProductVersion.
 * Strips pre-release tags, pads missing segments with 0.
 *   "1.2.3"        → "1.2.3.0"
 *   "1.2.3-beta.1" → "1.2.3.0"
 *   "1.2"          → "1.2.0.0"
 */
export function normalizeVersion(version: string): string {
	const clean = version.split(/[-+]/)[0] ?? "0";
	const parts = clean.split(".").map((p) => parseInt(p, 10) || 0);
	while (parts.length < 4) parts.push(0);
	return parts.slice(0, 4).join(".");
}

/** Generate NSIS WriteRegStr blocks to register URL protocols. */
function buildUrlProtocolsInstall(
	schemes: string[],
	escapedName: string,
): string {
	if (!schemes.length) return "  ; (no URL protocols configured)";
	return schemes
		.map((scheme) => {
			const s = scheme.replace(/[^\w-]/g, "");
			return [
				`  WriteRegStr HKCU "Software\\Classes\\${s}" "" "URL:${escapedName} protocol"`,
				`  WriteRegStr HKCU "Software\\Classes\\${s}" "URL Protocol" ""`,
				`  WriteRegStr HKCU "Software\\Classes\\${s}\\DefaultIcon" "" "$INSTDIR\\bin\\launcher.exe,0"`,
				`  WriteRegStr HKCU "Software\\Classes\\${s}\\shell\\open\\command" "" '"$INSTDIR\\bin\\launcher.exe" "%1"'`,
			].join("\n");
		})
		.join("\n\n");
}

/** Generate NSIS DeleteRegKey blocks to remove URL protocols. */
function buildUrlProtocolsUninstall(schemes: string[]): string {
	if (!schemes.length) return "  ; (no URL protocols configured)";
	return schemes
		.map((scheme) => {
			const s = scheme.replace(/[^\w-]/g, "");
			return `  DeleteRegKey HKCU "Software\\Classes\\${s}"`;
		})
		.join("\n");
}

/**
 * Generate the NSIS block that detects a legacy extractor-based install.
 * Placed inside .onInit — only sets $LegacyFound, never deletes anything.
 */
function buildLegacyDetectBlock(identifier: string, channel: string): string {
	const legacyDir = `$LOCALAPPDATA\\${escapeNsisString(identifier)}\\${escapeNsisString(channel)}\\app`;
	return [
		`  IfFileExists "${legacyDir}\\bin\\launcher.exe" 0 +2`,
		`    StrCpy $LegacyFound 1`,
	].join("\n");
}

/**
 * Generate the NSIS block that cleans up a legacy extractor install.
 * Runs inside the Install section AFTER new files are copied and verified.
 * Only executes if $LegacyFound was set in .onInit AND the new install
 * succeeded (verified by checking $INSTDIR\bin\launcher.exe exists).
 */
function buildLegacyCleanupBlock(
	identifier: string,
	channel: string,
	appName: string,
): string {
	const legacyAppDir = `$LOCALAPPDATA\\${escapeNsisString(identifier)}\\${escapeNsisString(channel)}\\app`;
	const legacyExtractionDir = `$LOCALAPPDATA\\${escapeNsisString(identifier)}\\${escapeNsisString(channel)}\\self-extraction`;
	const legacyChannelDir = `$LOCALAPPDATA\\${escapeNsisString(identifier)}\\${escapeNsisString(channel)}`;
	const legacyIdDir = `$LOCALAPPDATA\\${escapeNsisString(identifier)}`;
	const escapedAppName = escapeNsisString(appName);

	return [
		`  $\{If} $LegacyFound = 1`,
		`    ; Verify new install succeeded before touching legacy files`,
		`    IfFileExists "$INSTDIR\\bin\\launcher.exe" 0 legacy_skip`,
		``,
		`    ; Remove legacy app directory`,
		`    RMDir /r "${legacyAppDir}"`,
		``,
		`    ; Remove legacy self-extraction cache (tars won't match new paths)`,
		`    RMDir /r "${legacyExtractionDir}"`,
		``,
		`    ; Remove legacy desktop shortcut (created by extractor's PowerShell)`,
		`    Delete "$DESKTOP\\${escapedAppName}.lnk"`,
		``,
		`    ; Remove legacy Start Menu shortcut`,
		`    Delete "$SMPROGRAMS\\${escapedAppName}.lnk"`,
		``,
		`    ; Remove parent dirs only if empty`,
		`    RMDir "${legacyChannelDir}"`,
		`    RMDir "${legacyIdDir}"`,
		``,
		`    legacy_skip:`,
		`  $\{EndIf}`,
	].join("\n");
}

/**
 * Generate the NSIS block that checks for and installs the WebView2 runtime.
 * Only emitted when bundleCEF is false (app depends on system WebView2).
 * Checks both HKLM and HKCU registry keys; downloads the bootstrapper
 * (~1.8 KB stub) if the runtime is not found.
 */
function buildWebView2InstallSection(bundleCEF: boolean): string {
	if (bundleCEF) {
		return "  ; (CEF bundled — WebView2 runtime not required)";
	}
	return [
		`  ; Check if WebView2 runtime is already installed`,
		`  ReadRegStr $0 HKLM "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BEE-13A6279FE04D}" "pv"`,
		`  $\{If} $0 == ""`,
		`    ReadRegStr $0 HKCU "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BEE-13A6279FE04D}" "pv"`,
		`  $\{EndIf}`,
		`  $\{If} $0 == ""`,
		`    ; WebView2 runtime not found — download and install the bootstrapper`,
		`    DetailPrint "Installing Microsoft WebView2 Runtime..."`,
		`    NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\\MicrosoftEdgeWebview2Setup.exe"`,
		`    Pop $0`,
		`    $\{If} $0 == "success"`,
		`      ExecWait '"$TEMP\\MicrosoftEdgeWebview2Setup.exe" /silent /install' $0`,
		`      Delete "$TEMP\\MicrosoftEdgeWebview2Setup.exe"`,
		`    $\{Else}`,
		`      ; Download failed — warn but continue (WebView2 may be available via Windows Update)`,
		`      DetailPrint "Warning: Could not download WebView2 runtime ($0). The app may not work correctly."`,
		`    $\{EndIf}`,
		`  $\{Else}`,
		`    DetailPrint "WebView2 runtime already installed (version $0)"`,
		`  $\{EndIf}`,
	].join("\n");
}

/** Generate NSIS RMDir/Delete blocks for app data directories. */
function buildAppDataDeleteSection(appDataPaths: string[]): string {
	if (!appDataPaths.length)
		return "    ; (no appDataPaths configured — no app data deleted)";
	return appDataPaths
		.map(
			(p) =>
				`    RMDir /r "$LOCALAPPDATA\\${escapeNsisString(p)}"` +
				"\n" +
				`    RMDir /r "$APPDATA\\${escapeNsisString(p)}"`,
		)
		.join("\n");
}

/** Replace all occurrences of {{KEY}} in the template. */
function renderTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	let result = template;
	for (const [key, value] of Object.entries(vars)) {
		// Replace {{KEY}} globally
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface NsisInstallerOptions {
	/** Path to makensis.exe */
	makensisPath: string;
	/** Path to the build folder (e.g. build/stable-win-x64) */
	buildFolder: string;
	/** Path to the pre-tar extracted app bundle directory */
	appBundleFolder: string;
	/** App file name without extension (e.g. "NovaWallet" or "NovaWallet-canary") */
	appFileName: string;
	/** The Electrobun config object */
	config: {
		app: {
			name: string;
			version: string;
			identifier: string;
			description?: string;
			urlSchemes?: string[];
		};
		build?: {
			win?: {
				bundleCEF?: boolean;
				nsis?: {
					enabled?: boolean;
					installMode?: "currentUser" | "perMachine";
					allowDowngrades?: boolean;
					publisher?: string;
					homepage?: string;
					desktopShortcut?: boolean;
					startMenuFolder?: string;
					appDataPaths?: string[];
				};
			};
		};
	};
	/** Build environment: "stable" | "canary" | … */
	buildEnvironment: string;
	/** Path to the .ico file for the installer (optional) */
	icoPath?: string;
}

/**
 * Generate a NSIS .exe installer for the given app bundle.
 *
 * @returns Absolute path to the compiled installer .exe, or null if NSIS is
 *          disabled, makensisPath is unavailable, or compilation fails.
 */
export async function generateNsisInstaller(
	opts: NsisInstallerOptions,
): Promise<string | null> {
	const { makensisPath, buildFolder, appBundleFolder, appFileName, config, icoPath } =
		opts;

	const nsisConfig = config.build?.win?.nsis ?? {};
	if (nsisConfig.enabled === false) return null;

	if (!makensisPath) {
		console.warn("[nsis] makensisPath not provided — skipping NSIS installer");
		return null;
	}

	if (!existsSync(appBundleFolder)) {
		console.error(`[nsis] App bundle folder not found: ${appBundleFolder}`);
		return null;
	}

	// ── Resolve config values ──────────────────────────────────────────────────
	const appName = config.app.name;
	const appNameSanitized = appName.replace(/\s+/g, "");
	const appVersion = config.app.version;
	const appIdentifier = config.app.identifier;
	const publisher = nsisConfig.publisher ?? appName;
	const description = config.app.description ?? appName;
	const homepage = nsisConfig.homepage ?? "";
	const installMode = nsisConfig.installMode ?? "currentUser";
	const allowDowngrades = nsisConfig.allowDowngrades === true ? "true" : "false";
	const desktopShortcut =
		nsisConfig.desktopShortcut !== false ? "true" : "false";
	const startMenuFolder = nsisConfig.startMenuFolder ?? appName;
	const urlSchemes = config.app.urlSchemes ?? [];
	const appDataPaths = nsisConfig.appDataPaths ?? [];

	// Install directory
	const installDir =
		installMode === "perMachine"
			? `$PROGRAMFILES64\\${escapeNsisString(appName)}`
			: `$LOCALAPPDATA\\${escapeNsisString(appName)}`;

	// appFileName already includes the full naming convention (e.g.
	// "NovaWallet-Setup-nsis" or "NovaWallet-canary-Setup-nsis") as produced
	// by getNsisSetupFileName() in naming.ts, so just append the extension.
	const outputFile = join(buildFolder, `${appFileName}.exe`);

	// Icon directives
	const muiIconLine = icoPath
		? `!define MUI_ICON    "${icoPath.replace(/\\/g, "\\\\")}"`
		: "";
	const muiUniconLine = icoPath
		? `!define MUI_UNICON  "${icoPath.replace(/\\/g, "\\\\")}"`
		: "";

	// ── Render template ───────────────────────────────────────────────────────
	const vars: Record<string, string> = {
		APP_NAME: escapeNsisString(appName),
		APP_NAME_SANITIZED: escapeNsisString(appNameSanitized),
		APP_VERSION: escapeNsisString(appVersion),
		APP_VERSION_4SEG: normalizeVersion(appVersion),
		APP_IDENTIFIER: escapeNsisString(appIdentifier),
		APP_PUBLISHER: escapeNsisString(publisher),
		APP_DESCRIPTION: escapeNsisString(description),
		HOMEPAGE: escapeNsisString(homepage),
		OUTPUT_FILE: outputFile.replace(/\\/g, "\\\\"),
		BUNDLE_DIR: appBundleFolder.replace(/\\/g, "\\\\"),
		INSTALL_DIR: installDir,
		INSTALL_MODE: installMode,
		ALLOW_DOWNGRADES: allowDowngrades,
		DESKTOP_SHORTCUT: desktopShortcut,
		START_MENU_FOLDER: escapeNsisString(startMenuFolder),
		MUI_ICON_LINE: muiIconLine,
		MUI_UNICON_LINE: muiUniconLine,
		URL_PROTOCOLS_INSTALL: buildUrlProtocolsInstall(
			urlSchemes,
			escapeNsisString(appName),
		),
		URL_PROTOCOLS_UNINSTALL: buildUrlProtocolsUninstall(urlSchemes),
		APPDATA_DELETE_SECTION: buildAppDataDeleteSection(appDataPaths),
		LEGACY_DETECT_BLOCK: buildLegacyDetectBlock(
			appIdentifier,
			opts.buildEnvironment,
		),
		LEGACY_CLEANUP_BLOCK: buildLegacyCleanupBlock(
			appIdentifier,
			opts.buildEnvironment,
			appName,
		),
		WEBVIEW2_INSTALL_SECTION: buildWebView2InstallSection(
			config.build?.win?.bundleCEF ?? false,
		),
	};

	const renderedScript = renderTemplate(NSIS_TEMPLATE, vars);

	// ── Write .nsi script ─────────────────────────────────────────────────────
	mkdirSync(buildFolder, { recursive: true });
	const scriptPath = join(buildFolder, `${appFileName}-installer.nsi`);
	writeFileSync(scriptPath, renderedScript, "utf8");
	console.log(`[nsis] Script written to ${scriptPath}`);

	// ── Compile ───────────────────────────────────────────────────────────────
	console.log(`[nsis] Compiling installer with ${makensisPath}...`);
	const result = spawnSync(makensisPath, [scriptPath], {
		stdio: "inherit",
		encoding: "utf8",
		cwd: buildFolder,
	});

	if (result.error) {
		console.error(`[nsis] Failed to spawn makensis: ${result.error.message}`);
		return null;
	}
	if (result.status !== 0) {
		console.error(`[nsis] makensis exited with code ${result.status}`);
		return null;
	}

	if (!existsSync(outputFile)) {
		console.error(`[nsis] Compiled installer not found at ${outputFile}`);
		return null;
	}

	console.log(`[nsis] Installer created: ${outputFile}`);
	return outputFile;
}
