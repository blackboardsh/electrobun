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
 * Generates the bundle file name (with platform-specific extension).
 * macOS: "AppName.app" or "AppName-channel.app"
 * Others: "AppName" or "AppName-channel"
 */
export function getBundleFileName(appName: string, buildEnvironment: BuildEnvironment, os: SupportedOS): string {
  const appFileName = getAppFileName(appName, buildEnvironment);
  return os === 'macos' ? `${appFileName}.app` : appFileName;
}

/**
 * Generates the platform folder name for artifacts.
 * Format: "channel-os-arch" (e.g., "stable-macos-arm64", "canary-win-x64")
 */
export function getPlatformFolder(buildEnvironment: BuildEnvironment, os: SupportedOS, arch: SupportedArch): string {
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
 * Format: "AppName-Setup.exe" (stable) or "AppName-Setup-channel.exe" (non-stable)
 */
export function getWindowsSetupFileName(appName: string, buildEnvironment: BuildEnvironment): string {
  return buildEnvironment === 'stable'
    ? `${appName}-Setup.exe`
    : `${appName}-Setup-${buildEnvironment}.exe`;
}

/**
 * Generates the Linux self-extracting binary file name.
 * Format: "AppName-Setup.run" (stable) or "AppName-Setup-channel.run" (non-stable)
 */
export function getLinuxSetupFileName(appName: string, buildEnvironment: BuildEnvironment): string {
  return buildEnvironment === 'stable'
    ? `${appName}-Setup.run`
    : `${appName}-Setup-${buildEnvironment}.run`;
}

/**
 * Generates the Linux AppImage wrapper name (without extension).
 * Format: "AppName-Setup" (stable) or "AppName-Setup-channel" (non-stable)
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
 * Generates the DMG volume name for macOS during creation.
 * Uses sanitized name with "-stable" suffix for stable builds to avoid
 * CI volume mounting conflicts. The DMG is renamed after creation.
 */
export function getDmgVolumeName(appFileName: string, buildEnvironment: BuildEnvironment): string {
  const baseName = sanitizeVolumeNameForHdiutil(appFileName);
  return buildEnvironment === 'stable' ? `${baseName}-stable` : baseName;
}

/**
 * Constructs the full URL for the update.json file.
 */
export function getUpdateInfoUrl(bucketUrl: string, platformFolder: string): string {
  return `${bucketUrl}/${platformFolder}/update.json`;
}

/**
 * Constructs the full URL for a patch file.
 */
export function getPatchFileUrl(bucketUrl: string, platformFolder: string, hash: string): string {
  return `${bucketUrl}/${platformFolder}/${hash}.patch`;
}

/**
 * Constructs the full URL for a tarball.
 */
export function getTarballUrl(bucketUrl: string, platformFolder: string, tarballFileName: string): string {
  return `${bucketUrl}/${platformFolder}/${tarballFileName}`;
}
