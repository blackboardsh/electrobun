import type { SupportedOS, SupportedArch } from './platform';

/**
 * Build environment/channel types.
 * "stable" is special - it produces artifacts without a channel suffix.
 */
export type BuildEnvironment = 'stable' | 'canary' | 'dev' | (string & {});

/**
 * Sanitizes an app name by removing spaces.
 * Used as the base for all artifact naming.
 */
export function sanitizeAppName(appName: string): string {
  return appName.replace(/ /g, '');
}

/**
 * Generates the app file name based on build environment.
 * Format: "AppName" (stable) or "AppName-channel" (non-stable)
 *
 * @example
 * getAppFileName("My App", "stable") // "MyApp"
 * getAppFileName("My App", "canary") // "MyApp-canary"
 */
export function getAppFileName(appName: string, buildEnvironment: BuildEnvironment): string {
  const sanitized = sanitizeAppName(appName);
  return buildEnvironment === 'stable' ? sanitized : `${sanitized}-${buildEnvironment}`;
}

/**
 * Generates the macOS bundle display name (with spaces preserved).
 * Used for the actual .app folder name on macOS.
 * Format: "App Name" (stable) or "App Name-channel" (non-stable)
 *
 * @example
 * getMacOSBundleDisplayName("My App", "stable") // "My App"
 * getMacOSBundleDisplayName("My App", "canary") // "My App-canary"
 */
export function getMacOSBundleDisplayName(appName: string, buildEnvironment: BuildEnvironment): string {
  return buildEnvironment === 'stable' ? appName : `${appName}-${buildEnvironment}`;
}

/**
 * Generates the bundle file name (with platform-specific extension).
 * macOS: "AppName.app" or "AppName-channel.app"
 * Others: "AppName" or "AppName-channel"
 */
export function getBundleFileName(appName: string, buildEnvironment: BuildEnvironment, os: SupportedOS): string {
  const appFileName = getAppFileName(appName, buildEnvironment);
  return os === 'macos' ? `${appFileName}.app` : appFileName;
}

/**
 * Generates the platform prefix for artifacts.
 * Format: "channel-os-arch" (e.g., "stable-macos-arm64", "canary-win-x64")
 * Used for flat file naming in artifact folders and bucket URLs.
 */
export function getPlatformPrefix(buildEnvironment: BuildEnvironment, os: SupportedOS, arch: SupportedArch): string {
  return `${buildEnvironment}-${os}-${arch}`;
}

/**
 * Generates the tarball file name for update distribution.
 * macOS: "AppFileName.app.tar.zst"
 * Others: "AppFileName.tar.zst"
 */
export function getTarballFileName(appFileName: string, os: SupportedOS): string {
  return os === 'macos' ? `${appFileName}.app.tar.zst` : `${appFileName}.tar.zst`;
}

/**
 * Generates the Windows installer setup file name.
 * Preserves spaces in app name for user-friendly display.
 * Format: "App Name-Setup.exe" (stable) or "App Name-Setup-channel.exe" (non-stable)
 */
export function getWindowsSetupFileName(appName: string, buildEnvironment: BuildEnvironment): string {
  return buildEnvironment === 'stable'
    ? `${appName}-Setup.exe`
    : `${appName}-Setup-${buildEnvironment}.exe`;
}

/**
 * Generates the Linux AppImage wrapper name (without extension).
 * Preserves spaces in app name for user-friendly display.
 * Format: "App Name-Setup" (stable) or "App Name-Setup-channel" (non-stable)
 */
export function getLinuxAppImageBaseName(appName: string, buildEnvironment: BuildEnvironment): string {
  return buildEnvironment === 'stable'
    ? `${appName}-Setup`
    : `${appName}-Setup-${buildEnvironment}`;
}

/**
 * Generates the full Linux AppImage file name.
 */
export function getLinuxAppImageFileName(appName: string, buildEnvironment: BuildEnvironment): string {
  return `${getLinuxAppImageBaseName(appName, buildEnvironment)}.AppImage`;
}

/**
 * Sanitizes a volume name for hdiutil (macOS DMG creation).
 * Removes all non-alphanumeric characters except spaces.
 */
export function sanitizeVolumeNameForHdiutil(name: string): string {
  return name.replace(/[^a-zA-Z0-9 ]/g, '').trim();
}

/**
 * Generates the DMG volume name for macOS.
 * Takes the original app name (with spaces) and preserves them for display.
 * Format: "App Name" (stable) or "App Name-channel" (non-stable)
 */
export function getDmgVolumeName(appName: string, buildEnvironment: BuildEnvironment): string {
  const baseName = sanitizeVolumeNameForHdiutil(appName);
  return buildEnvironment === 'stable' ? baseName : `${baseName}-${buildEnvironment}`;
}

/**
 * Constructs the full URL for the update.json file.
 * Uses flat prefix-based naming for compatibility with GitHub Releases and other hosts.
 */
export function getUpdateInfoUrl(baseUrl: string, platformPrefix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${platformPrefix}-update.json`;
}

/**
 * Constructs the full URL for a patch file.
 * Uses flat prefix-based naming for compatibility with GitHub Releases and other hosts.
 */
export function getPatchFileUrl(baseUrl: string, platformPrefix: string, hash: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${platformPrefix}-${hash}.patch`;
}

/**
 * Constructs the full URL for a tarball.
 * Uses flat prefix-based naming for compatibility with GitHub Releases and other hosts.
 */
export function getTarballUrl(baseUrl: string, platformPrefix: string, tarballFileName: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${platformPrefix}-${tarballFileName}`;
}
