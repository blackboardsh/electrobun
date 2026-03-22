/**
 * WiX v3 .msi installer generator for Electrobun Windows builds.
 *
 * Generates a native Windows Installer (MSI) package suitable for:
 *  - Group Policy / SCCM / Intune / MDM deployment
 *  - Per-user installation (no admin rights required by default)
 *  - Seamless major upgrades via the MajorUpgrade element
 *  - Stable UpgradeCode GUID derived from config.app.identifier (UUID v5)
 *  - Start Menu and Desktop shortcuts
 *  - High compression (LZMA via WiX cab)
 *
 * Requires WiX v3 (candle.exe + light.exe).
 * Auto-downloads via ensureWix() in tools.ts.
 */

import { join, relative } from "path";
import { writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { createHash } from "crypto";

// ── UUID v5 (stable GUIDs) ────────────────────────────────────────────────────

// Standard DNS namespace UUID as bytes (RFC 4122 §4.3)
const UUID_NS_DNS = Uint8Array.from(
	Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"),
);

/**
 * Compute a UUID v5 from a namespace UUID + name string.
 * Used to generate deterministic GUIDs for WiX components and the UpgradeCode.
 */
function uuidV5(name: string, ns: Uint8Array = UUID_NS_DNS): string {
	// SHA-1 hash of namespace + name, then apply UUID v5 version and variant bits
	const raw: number[] = Array.from(
		createHash("sha1").update(ns).update(name).digest(),
	);
	// version 5
	raw[6] = ((raw[6] ?? 0) & 0x0f) | 0x50;
	// variant 10xx
	raw[8] = ((raw[8] ?? 0) & 0x3f) | 0x80;
	const h = raw
		.slice(0, 16)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return [
		h.slice(0, 8),
		h.slice(8, 12),
		h.slice(12, 16),
		h.slice(16, 20),
		h.slice(20, 32),
	]
		.join("-")
		.toUpperCase();
}

// ── Directory-tree walking ────────────────────────────────────────────────────

interface FileEntry {
	/** Absolute path on disk */
	absolutePath: string;
	/** Relative path from the bundle root (uses OS path separators) */
	relativePath: string;
}

/** Recursively enumerate all files in a directory. */
function walkDirectory(dir: string, base: string = dir): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const dirent of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, dirent.name);
		if (dirent.isDirectory()) {
			entries.push(...walkDirectory(full, base));
		} else if (dirent.isFile()) {
			entries.push({
				absolutePath: full,
				relativePath: relative(base, full),
			});
		}
	}
	return entries;
}

// ── ID generation helpers ────────────────────────────────────────────────────

/**
 * Turn a relative path into a valid WiX XML ID.
 * IDs must start with a letter or underscore and contain only
 * letters, digits, underscores, or dots (max 72 chars).
 */
function toWixId(prefix: string, relativePath: string): string {
	const sanitized = relativePath
		.replace(/[\\\/]/g, "_") // path separators → underscore
		.replace(/[^a-zA-Z0-9_.]/g, "_") // other non-alnum → underscore
		.replace(/^(\d)/, "_$1"); // must not start with digit
	const combined = `${prefix}_${sanitized}`;
	// WiX IDs are limited to 72 characters; truncate + append hash if needed
	if (combined.length <= 72) return combined;
	const tail = createHash("sha1")
		.update(relativePath)
		.digest("hex")
		.slice(0, 8)
		.toUpperCase();
	return combined.slice(0, 63) + "_" + tail;
}

// ── WXS XML generation ────────────────────────────────────────────────────────

interface DirectoryNode {
	name: string;
	id: string;
	children: Map<string, DirectoryNode>;
	files: FileEntry[];
}

/** Build a tree of directory nodes from the flat file list. */
function buildDirTree(files: FileEntry[]): DirectoryNode {
	const root: DirectoryNode = {
		name: "",
		id: "INSTALLFOLDER",
		children: new Map(),
		files: [],
	};

	for (const file of files) {
		const parts = file.relativePath.split(/[\\/]/);
		let node = root;

		// Walk down to the containing directory node
		for (let i = 0; i < parts.length - 1; i++) {
			const segment = parts[i] as string;
			if (!node.children.has(segment)) {
				const childId = toWixId(
					"Dir",
					parts.slice(0, i + 1).join("_"),
				);
				node.children.set(segment, {
					name: segment,
					id: childId,
					children: new Map(),
					files: [],
				});
			}
			node = node.children.get(segment)!;
		}
		node.files.push(file);
	}

	return root;
}

/** Render a DirectoryNode and its children as WiX XML. */
function renderDirectoryNode(
	node: DirectoryNode,
	appIdentifier: string,
	componentIds: string[],
	indent: string,
	perUser: boolean,
	regRoot: string,
	registryKeyBase: string,
): string {
	const lines: string[] = [];

	// ICE64: per-user directories need RemoveFolder entries for uninstall cleanup
	if (perUser) {
		const rmId = toWixId("RM", node.id);
		const rmCompId = toWixId("CompRM", node.id);
		const rmCompGuid = uuidV5(`${appIdentifier}/RemoveFolder/${node.id}`);
		componentIds.push(rmCompId);
		lines.push(
			`${indent}<Component Id="${rmCompId}" Guid="${rmCompGuid}">`,
			`${indent}  <RemoveFolder Id="${rmId}" On="uninstall" />`,
			`${indent}  <RegistryValue Root="${regRoot}" Key="${registryKeyBase}\\Components" Name="${rmId}" Type="integer" Value="1" KeyPath="yes" />`,
			`${indent}</Component>`,
		);
	}

	// Files in this directory — each gets its own Component
	for (const file of node.files) {
		const relPath = file.relativePath;
		const fileId = toWixId("File", relPath);
		const compId = toWixId("Comp", relPath);
		const compGuid = uuidV5(`${appIdentifier}/${relPath}`);

		componentIds.push(compId);

		if (perUser) {
			// ICE38: per-user components must use a registry key under HKCU as KeyPath
			lines.push(
				`${indent}<Component Id="${compId}" Guid="${compGuid}">`,
				`${indent}  <File Id="${fileId}" Source="${file.absolutePath}" />`,
				`${indent}  <RegistryValue Root="${regRoot}" Key="${registryKeyBase}\\Components" Name="${fileId}" Type="integer" Value="1" KeyPath="yes" />`,
				`${indent}</Component>`,
			);
		} else {
			lines.push(
				`${indent}<Component Id="${compId}" Guid="${compGuid}">`,
				`${indent}  <File Id="${fileId}" Source="${file.absolutePath}" KeyPath="yes" />`,
				`${indent}</Component>`,
			);
		}
	}

	// Subdirectories
	for (const [, child] of node.children) {
		lines.push(`${indent}<Directory Id="${child.id}" Name="${child.name}">`);
		lines.push(
			renderDirectoryNode(child, appIdentifier, componentIds, indent + "  ", perUser, regRoot, registryKeyBase),
		);
		lines.push(`${indent}</Directory>`);
	}

	return lines.join("\n");
}

/** Build the complete WXS XML document. */
function buildWxs(opts: {
	appName: string;
	appVersion: string;
	appIdentifier: string;
	publisher: string;
	description: string;
	upgradeCode: string;
	installFolderName: string;
	bundleDir: string;
	icoPath?: string;
	installMode: "currentUser" | "perMachine";
	allowDowngrades: boolean;
	desktopShortcut: boolean;
	startMenuFolder: string;
	bundleCEF: boolean;
	license?: string;
	bannerImage?: string;
	dialogImage?: string;
	homepage?: string;
	launchAfterInstall: boolean;
}): string {
	const {
		appName,
		appVersion,
		appIdentifier,
		publisher,
		description,
		upgradeCode,
		installFolderName,
		bundleDir,
		icoPath,
		installMode,
		allowDowngrades,
		desktopShortcut,
		startMenuFolder,
		bundleCEF,
		license,
		bannerImage,
		dialogImage,
		homepage,
		launchAfterInstall,
	} = opts;

	// perMachine installs use HKLM; perUser installs use HKCU
	const perUser = installMode === "currentUser";
	const regRoot = perUser ? "HKCU" : "HKLM";
	const installScope = perUser ? "perUser" : "perMachine";
	const registryKeyBase = `Software\\${publisher}\\${appName}`;

	// Collect all files from the app bundle
	const files = walkDirectory(bundleDir);
	const tree = buildDirTree(files);
	const componentIds: string[] = [];
	const directoryBody = renderDirectoryNode(
		tree,
		appIdentifier,
		componentIds,
		"          ",
		perUser,
		regRoot,
		registryKeyBase,
	);

	// Stable GUIDs for non-file components
	const startMenuShortcutGuid = uuidV5(`${appIdentifier}/StartMenuShortcut`);
	const desktopShortcutGuid = uuidV5(`${appIdentifier}/DesktopShortcut`);
	const registryCompGuid = uuidV5(`${appIdentifier}/RegistryEntries`);

	// Component refs for the Feature element
	const featureComponentIds = [
		...componentIds,
		"CompStartMenuShortcut",
		...(desktopShortcut ? ["CompDesktopShortcut"] : []),
		"CompRegistryEntries",
	];
	const compRefs = featureComponentIds
		.map((id) => `      <ComponentRef Id="${id}" />`)
		.join("\n");

	// Icon element (optional)
	const iconSection = icoPath
		? `    <Icon Id="AppIcon.ico" SourceFile="${icoPath.replace(/\\/g, "\\\\")}" />\n` +
		  `    <Property Id="ARPPRODUCTICON" Value="AppIcon.ico" />`
		: "";

	// ── WixUI_InstallDir with smart license handling ──────────────────────────
	const hasLicense = !!license;
	const licenseVariable = hasLicense
		? `\n    <WixVariable Id="WixUILicenseRtf" Value="${escapeXml(license!)}" />`
		: "";
	const licenseSkipPublish = hasLicense
		? ""
		: `
      <Publish Dialog="WelcomeDlg" Control="Next" Event="NewDialog" Value="InstallDirDlg" Order="2">1</Publish>
      <Publish Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="WelcomeDlg" Order="2">1</Publish>`;

	// ── Launch-app checkbox on exit dialog ─────────────────────────────────────
	const launchSection = launchAfterInstall
		? `
    <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="Launch ${escapeXml(appName)}" />
    <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOX" Value="1" />
    <CustomAction Id="LaunchApplication" Impersonate="yes"
                  FileKey="File_bin_launcher.exe" ExeCommand="" Return="asyncNoWait" />`
		: "";

	const launchPublish = launchAfterInstall
		? `
      <Publish Dialog="ExitDialog" Control="Finish" Event="DoAction" Value="LaunchApplication">
        WIXUI_EXITDIALOGOPTIONALCHECKBOX = 1 and NOT Installed
      </Publish>`
		: "";

	// ── Banner and dialog image branding ───────────────────────────────────────
	const bannerVariable = bannerImage
		? `\n    <WixVariable Id="WixUIBannerBmp" Value="${escapeXml(bannerImage)}" />`
		: "";
	const dialogVariable = dialogImage
		? `\n    <WixVariable Id="WixUIDialogBmp" Value="${escapeXml(dialogImage)}" />`
		: "";

	// ── Optional homepage ARP properties ──────────────────────────────────────
	const homepageProperties = homepage
		? `\n    <Property Id="ARPURLINFOABOUT" Value="${escapeXml(homepage)}" />` +
		  `\n    <Property Id="ARPHELPLINK" Value="${escapeXml(homepage)}" />` +
		  `\n    <Property Id="ARPURLUPDATEINFO" Value="${escapeXml(homepage)}" />`
		: "";

	return `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product
    Id="*"
    Name="${escapeXml(appName)}"
    Language="1033"
    Version="${sanitizeVersionForMsi(appVersion)}"
    Manufacturer="${escapeXml(publisher)}"
    UpgradeCode="${upgradeCode}">

    <!-- Windows Installer 5.0 required for per-user/per-machine install scope (Windows 7+) -->
    <Package
      InstallerVersion="500"
      Compressed="yes"
      InstallScope="${installScope}"
      Platform="x64"${description ? `\n      Description="${escapeXml(description)}"` : ""}
      Manufacturer="${escapeXml(publisher)}" />

    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />

    <!-- Seamless major upgrade: remove old version before installing new -->
    <MajorUpgrade${allowDowngrades ? "" : `\n      DowngradeErrorMessage="A newer version of ${escapeXml(appName)} is already installed. Downgrading is not supported."`}
      Schedule="afterInstallInitialize" />

    <!-- Per-user non-advertised shortcuts require this property -->
    <Property Id="DISABLEADVTSHORTCUTS" Value="1" />

    <!-- Disable Repair/Modify in Add/Remove Programs -->
    <Property Id="ARPNOREPAIR" Value="yes" Secure="yes" />
    <SetProperty Id="ARPNOMODIFY" Value="1" After="InstallValidate" Sequence="execute" />

    <!-- Force full file reinstall on upgrade (reinstall all files, rewrite registry, recreate shortcuts) -->
    <Property Id="REINSTALLMODE" Value="amus" />${homepageProperties}

${iconSection}

    <!-- ── Detect previous install location via registry ───────────────── -->
    <Property Id="INSTALLFOLDER">
      <RegistrySearch Id="PrevInstallDir" Root="${regRoot}"
        Key="Software\\${escapeXml(publisher)}\\${escapeXml(appName)}" Name="InstallDir" Type="raw" />
    </Property>

    <!-- ── Directory structure ─────────────────────────────────────────── -->
    <Directory Id="TARGETDIR" Name="SourceDir">

      <!-- Install folder: perUser → %LOCALAPPDATA%; perMachine → %ProgramFiles% -->
${installMode === "perMachine"
	? `      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="${escapeXml(installFolderName)}">
${directoryBody}
        </Directory>
      </Directory>`
	: `      <Directory Id="LocalAppDataFolder">
        <Directory Id="INSTALLFOLDER" Name="${escapeXml(installFolderName)}">
${directoryBody}
        </Directory>
      </Directory>`
}

      <!-- Start menu -->
      <Directory Id="ProgramMenuFolder">
        <Directory Id="AppProgramMenuFolder" Name="${escapeXml(startMenuFolder)}" />
      </Directory>

      <!-- Desktop -->
      <Directory Id="DesktopFolder" Name="Desktop" />

    </Directory>

    <!-- ── Start Menu shortcut component ──────────────────────────────── -->
    <DirectoryRef Id="AppProgramMenuFolder">
      <Component Id="CompStartMenuShortcut" Guid="${startMenuShortcutGuid}">
        <Shortcut
          Id="StartMenuShortcut"
          Name="${escapeXml(appName)}"${description ? `\n          Description="${escapeXml(description)}"` : ""}
          Target="[INSTALLFOLDER]bin\\launcher.exe"
          WorkingDirectory="INSTALLFOLDER"
          Advertise="no" />
        <RemoveFolder Id="RemoveAppProgramMenuFolder" Directory="AppProgramMenuFolder" On="uninstall" />
        <!-- Registry KeyPath required for shortcuts -->
        <RegistryValue
          Root="${regRoot}"
          Key="Software\\${escapeXml(publisher)}\\${escapeXml(appName)}"
          Name="StartMenuShortcut"
          Type="integer"
          Value="1"
          KeyPath="yes" />
      </Component>
    </DirectoryRef>
${desktopShortcut ? `
    <!-- ── Desktop shortcut component ─────────────────────────────────── -->
    <DirectoryRef Id="DesktopFolder">
      <Component Id="CompDesktopShortcut" Guid="${desktopShortcutGuid}">
        <Shortcut
          Id="DesktopShortcut"
          Name="${escapeXml(appName)}"${description ? `\n          Description="${escapeXml(description)}"` : ""}
          Target="[INSTALLFOLDER]bin\\launcher.exe"
          WorkingDirectory="INSTALLFOLDER"
          Advertise="no" />
        <RegistryValue
          Root="${regRoot}"
          Key="Software\\${escapeXml(publisher)}\\${escapeXml(appName)}"
          Name="DesktopShortcut"
          Type="integer"
          Value="1"
          KeyPath="yes" />
      </Component>
    </DirectoryRef>` : ""}

    <!-- ── Add/Remove Programs registry entries + persist install dir ──── -->
    <DirectoryRef Id="INSTALLFOLDER">
      <Component Id="CompRegistryEntries" Guid="${registryCompGuid}">
        <RegistryValue
          Root="${regRoot}"
          Key="Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${escapeXml(appIdentifier)}"
          Name="DisplayName"
          Type="string"
          Value="${escapeXml(appName)}"
          KeyPath="yes" />
        <RegistryValue
          Root="${regRoot}"
          Key="Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${escapeXml(appIdentifier)}"
          Name="Publisher"
          Type="string"
          Value="${escapeXml(publisher)}" />
        <RegistryValue
          Root="${regRoot}"
          Key="Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${escapeXml(appIdentifier)}"
          Name="DisplayIcon"
          Type="string"
          Value="[INSTALLFOLDER]bin\\launcher.exe" />
        <!-- Persist install dir for upgrades -->
        <RegistryValue
          Root="${regRoot}"
          Key="Software\\${escapeXml(publisher)}\\${escapeXml(appName)}"
          Name="InstallDir"
          Type="string"
          Value="[INSTALLFOLDER]" />
      </Component>
    </DirectoryRef>

${!bundleCEF ? `    <!-- ── WebView2 runtime detection and installation ──────────────── -->
    <Property Id="WEBVIEW2_INSTALLED">
      <RegistrySearch
        Id="WebView2RegSearch"
        Root="HKLM"
        Key="SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BEE-13A6279FE04D}"
        Name="pv"
        Type="raw" />
    </Property>

    <CustomAction
      Id="InstallWebView2"
      Directory="TARGETDIR"
      ExeCommand='powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "&amp; { $$bootstrapper = Join-Path $$env:TEMP &apos;MicrosoftEdgeWebview2Setup.exe&apos;; Invoke-WebRequest -Uri &apos;https://go.microsoft.com/fwlink/p/?LinkId=2124703&apos; -OutFile $$bootstrapper -UseBasicParsing; Start-Process -FilePath $$bootstrapper -ArgumentList &apos;/silent /install&apos; -Wait; Remove-Item $$bootstrapper -ErrorAction SilentlyContinue }"'
      Return="ignore" />

    <InstallExecuteSequence>
      <Custom Action="InstallWebView2" Before="InstallFinalize">
        <![CDATA[NOT WEBVIEW2_INSTALLED AND NOT Installed]]>
      </Custom>
      <RemoveShortcuts>Installed AND NOT UPGRADINGPRODUCTCODE</RemoveShortcuts>
    </InstallExecuteSequence>
` : `    <!-- CEF bundled — WebView2 runtime not required -->
    <InstallExecuteSequence>
      <RemoveShortcuts>Installed AND NOT UPGRADINGPRODUCTCODE</RemoveShortcuts>
    </InstallExecuteSequence>
`}
    <!-- ── Feature ─────────────────────────────────────────────────────── -->
    <Feature Id="Main" Title="${escapeXml(appName)}" Level="1" ConfigurableDirectory="INSTALLFOLDER">
${compRefs}
    </Feature>
${launchSection}

    <!-- ── WixUI_InstallDir wizard UI ──────────────────────────────────── -->
    <UIRef Id="WixUI_InstallDir" />
    <UI>
      <Property Id="WIXUI_INSTALLDIR" Value="INSTALLFOLDER" />${licenseSkipPublish}${launchPublish}
    </UI>${licenseVariable}${bannerVariable}${dialogVariable}

  </Product>
</Wix>
`;
}

// ── XML / version helpers ──────────────────────────────────────────────────────

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Strip pre-release tags and ensure version is X.Y.Z[.W] (max 4 segments,
 * all numeric) — required by Windows Installer.
 */
function sanitizeVersionForMsi(version: string): string {
	const clean = version.split(/[-+]/)[0] ?? "0";
	const parts = clean.split(".").map((p) => parseInt(p, 10) || 0);
	while (parts.length < 3) parts.push(0);
	return parts.slice(0, 4).join(".");
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface MsiInstallerOptions {
	candlePath: string;
	lightPath: string;
	buildFolder: string;
	/** Path to the pre-tar extracted app bundle directory */
	appBundleFolder: string;
	appFileName: string;
	config: {
		app: {
			name: string;
			version: string;
			identifier: string;
			description?: string;
		};
		build?: {
			win?: {
				bundleCEF?: boolean;
				msi?: {
					enabled?: boolean;
					publisher?: string;
					upgradeCode?: string;
					installMode?: "currentUser" | "perMachine";
					allowDowngrades?: boolean;
					desktopShortcut?: boolean;
					startMenuFolder?: string;
					license?: string;
					bannerImage?: string;
					dialogImage?: string;
					homepage?: string;
					launchAfterInstall?: boolean;
					additionalCandleArgs?: string[];
					additionalLightArgs?: string[];
				};
			};
		};
	};
	buildEnvironment: string;
	icoPath?: string;
}

/**
 * Generate a WiX v3 .msi installer.
 *
 * @returns Absolute path to the compiled .msi, or null if MSI is disabled,
 *          WiX is unavailable, or compilation fails.
 */
export async function generateMsiInstaller(
	opts: MsiInstallerOptions,
): Promise<string | null> {
	const { candlePath, lightPath, buildFolder, appBundleFolder, appFileName, config, icoPath } =
		opts;

	const msiConfig = config.build?.win?.msi ?? {};
	if (msiConfig.enabled === false) return null;

	if (!existsSync(appBundleFolder)) {
		console.error(`[msi] App bundle folder not found: ${appBundleFolder}`);
		return null;
	}

	if (!existsSync(candlePath) || !existsSync(lightPath)) {
		console.error(`[msi] WiX binaries not found: candle=${candlePath} light=${lightPath}`);
		return null;
	}

	// ── Config values ─────────────────────────────────────────────────────────
	const appName = config.app.name;
	const appVersion = config.app.version;
	const appIdentifier = config.app.identifier;
	const publisher = msiConfig.publisher ?? appName;
	const description = config.app.description ?? "";
	const installMode = msiConfig.installMode ?? "currentUser";
	const allowDowngrades = msiConfig.allowDowngrades ?? false;
	const desktopShortcut = msiConfig.desktopShortcut ?? true;
	const startMenuFolder = msiConfig.startMenuFolder ?? appName;

	// Stable UpgradeCode: prefer explicit user-supplied GUID, otherwise derive
	// a deterministic UUID v5 from the app identifier so it never changes across
	// versions of the same application.
	const upgradeCode = msiConfig.upgradeCode ?? uuidV5(appIdentifier);

	// Sanitized name matching NSIS convention (no spaces, channel suffix for non-stable)
	const appNameSanitized = appName.replace(/\s+/g, "");
	const installFolderName =
		opts.buildEnvironment === "stable"
			? appNameSanitized
			: `${appNameSanitized}-${opts.buildEnvironment}`;

	const outputBaseName = `${appFileName}-setup.msi`;
	const outputMsi = join(buildFolder, outputBaseName);
	const outputWxs = join(buildFolder, `${appFileName}-installer.wxs`);
	const outputWixobj = join(buildFolder, `${appFileName}-installer.wixobj`);

	// ── Generate WXS ──────────────────────────────────────────────────────────
	console.log(`[msi] Generating WXS for ${appName} ${appVersion}...`);
	const wxsContent = buildWxs({
		appName,
		appVersion,
		appIdentifier,
		publisher,
		description,
		upgradeCode,
		installFolderName,
		bundleDir: appBundleFolder,
		icoPath,
		installMode,
		allowDowngrades,
		desktopShortcut,
		startMenuFolder,
		bundleCEF: config.build?.win?.bundleCEF ?? false,
		license: msiConfig.license,
		bannerImage: msiConfig.bannerImage,
		dialogImage: msiConfig.dialogImage,
		homepage: msiConfig.homepage,
		launchAfterInstall: msiConfig.launchAfterInstall ?? true,
	});

	mkdirSync(buildFolder, { recursive: true });
	writeFileSync(outputWxs, wxsContent, "utf8");
	console.log(`[msi] WXS written to ${outputWxs}`);

	// ── candle.exe (compile WXS → .wixobj) ───────────────────────────────────
	console.log(`[msi] Compiling with candle.exe...`);
	const candleArgs = [
		"-nologo",
		"-arch", "x64",
		"-ext", "WixUIExtension",
		"-out", outputWixobj,
		...(msiConfig.additionalCandleArgs ?? []),
		outputWxs,
	];
	const candleResult = spawnSync(
		candlePath,
		candleArgs,
		{ stdio: "inherit", cwd: buildFolder },
	);

	if (candleResult.error || candleResult.status !== 0) {
		console.error(
			`[msi] candle.exe failed: ${candleResult.error?.message ?? `exit code ${candleResult.status}`}`,
		);
		return null;
	}

	// ── light.exe (link .wixobj → .msi) ──────────────────────────────────────
	console.log(`[msi] Linking with light.exe...`);
	const lightArgs = [
		"-nologo",
		"-ext", "WixUIExtension",
		// Suppress ICE validation warnings common with per-user installs
		"-sw1076",  // ICE76: per-user shortcuts
		"-sw1073",  // ICE73: per-user shortcuts referenced without advertise
		"-out", outputMsi,
		...(msiConfig.additionalLightArgs ?? []),
		outputWixobj,
	];
	const lightResult = spawnSync(
		lightPath,
		lightArgs,
		{ stdio: "inherit", cwd: buildFolder },
	);

	if (lightResult.error || lightResult.status !== 0) {
		console.error(
			`[msi] light.exe failed: ${lightResult.error?.message ?? `exit code ${lightResult.status}`}`,
		);
		return null;
	}

	if (!existsSync(outputMsi)) {
		console.error(`[msi] Compiled installer not found at ${outputMsi}`);
		return null;
	}

	console.log(`[msi] Installer created: ${outputMsi}`);
	return outputMsi;
}
