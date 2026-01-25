import { describe, expect, it } from 'bun:test';
import {
  sanitizeAppName,
  getAppFileName,
  getBundleFileName,
  getPlatformFolder,
  getTarballFileName,
  getWindowsSetupFileName,
  getLinuxSetupFileName,
  getLinuxAppImageBaseName,
  getLinuxAppImageFileName,
  sanitizeVolumeNameForHdiutil,
  getDmgVolumeName,
  getUpdateInfoUrl,
  getPatchFileUrl,
  getTarballUrl,
} from './naming';

describe('sanitizeAppName', () => {
  it('removes spaces from app name', () => {
    expect(sanitizeAppName('My App')).toBe('MyApp');
    expect(sanitizeAppName('My  Multi  Spaced  App')).toBe('MyMultiSpacedApp');
  });

  it('preserves names without spaces', () => {
    expect(sanitizeAppName('MyApp')).toBe('MyApp');
  });

  it('handles empty string', () => {
    expect(sanitizeAppName('')).toBe('');
  });
});

describe('getAppFileName', () => {
  it('returns sanitized name without suffix for stable builds', () => {
    expect(getAppFileName('My App', 'stable')).toBe('MyApp');
  });

  it('appends channel suffix for canary builds', () => {
    expect(getAppFileName('My App', 'canary')).toBe('MyApp-canary');
  });

  it('appends channel suffix for dev builds', () => {
    expect(getAppFileName('My App', 'dev')).toBe('MyApp-dev');
  });

  it('handles custom channels', () => {
    expect(getAppFileName('My App', 'beta')).toBe('MyApp-beta');
    expect(getAppFileName('My App', 'nightly')).toBe('MyApp-nightly');
  });
});

describe('getBundleFileName', () => {
  describe('macOS', () => {
    it('adds .app extension for stable builds', () => {
      expect(getBundleFileName('My App', 'stable', 'macos')).toBe('MyApp.app');
    });

    it('adds .app extension for canary builds', () => {
      expect(getBundleFileName('My App', 'canary', 'macos')).toBe('MyApp-canary.app');
    });
  });

  describe('Windows', () => {
    it('returns plain name for stable builds', () => {
      expect(getBundleFileName('My App', 'stable', 'win')).toBe('MyApp');
    });

    it('returns plain name with suffix for canary builds', () => {
      expect(getBundleFileName('My App', 'canary', 'win')).toBe('MyApp-canary');
    });
  });

  describe('Linux', () => {
    it('returns plain name for stable builds', () => {
      expect(getBundleFileName('My App', 'stable', 'linux')).toBe('MyApp');
    });

    it('returns plain name with suffix for canary builds', () => {
      expect(getBundleFileName('My App', 'canary', 'linux')).toBe('MyApp-canary');
    });
  });
});

describe('getPlatformFolder', () => {
  it('constructs correct folder format for all platform combinations', () => {
    expect(getPlatformFolder('stable', 'macos', 'arm64')).toBe('stable-macos-arm64');
    expect(getPlatformFolder('stable', 'macos', 'x64')).toBe('stable-macos-x64');
    expect(getPlatformFolder('canary', 'win', 'x64')).toBe('canary-win-x64');
    expect(getPlatformFolder('dev', 'linux', 'arm64')).toBe('dev-linux-arm64');
    expect(getPlatformFolder('dev', 'linux', 'x64')).toBe('dev-linux-x64');
  });
});

describe('getTarballFileName', () => {
  describe('macOS', () => {
    it('uses .app.tar.zst extension', () => {
      expect(getTarballFileName('MyApp', 'macos')).toBe('MyApp.app.tar.zst');
    });

    it('preserves channel suffix in filename', () => {
      expect(getTarballFileName('MyApp-canary', 'macos')).toBe('MyApp-canary.app.tar.zst');
    });
  });

  describe('Windows', () => {
    it('uses .tar.zst extension', () => {
      expect(getTarballFileName('MyApp', 'win')).toBe('MyApp.tar.zst');
    });

    it('preserves channel suffix in filename', () => {
      expect(getTarballFileName('MyApp-canary', 'win')).toBe('MyApp-canary.tar.zst');
    });
  });

  describe('Linux', () => {
    it('uses .tar.zst extension', () => {
      expect(getTarballFileName('MyApp', 'linux')).toBe('MyApp.tar.zst');
    });

    it('preserves channel suffix in filename', () => {
      expect(getTarballFileName('MyApp-canary', 'linux')).toBe('MyApp-canary.tar.zst');
    });
  });
});

describe('getWindowsSetupFileName', () => {
  it('returns AppName-Setup.exe for stable builds', () => {
    expect(getWindowsSetupFileName('MyApp', 'stable')).toBe('MyApp-Setup.exe');
  });

  it('includes channel suffix for canary builds', () => {
    expect(getWindowsSetupFileName('MyApp', 'canary')).toBe('MyApp-Setup-canary.exe');
  });

  it('includes channel suffix for dev builds', () => {
    expect(getWindowsSetupFileName('MyApp', 'dev')).toBe('MyApp-Setup-dev.exe');
  });
});

describe('getLinuxSetupFileName', () => {
  it('returns AppName-Setup.run for stable builds', () => {
    expect(getLinuxSetupFileName('MyApp', 'stable')).toBe('MyApp-Setup.run');
  });

  it('includes channel suffix for canary builds', () => {
    expect(getLinuxSetupFileName('MyApp', 'canary')).toBe('MyApp-Setup-canary.run');
  });

  it('includes channel suffix for dev builds', () => {
    expect(getLinuxSetupFileName('MyApp', 'dev')).toBe('MyApp-Setup-dev.run');
  });
});

describe('getLinuxAppImageBaseName', () => {
  it('returns AppName-Setup for stable builds', () => {
    expect(getLinuxAppImageBaseName('MyApp', 'stable')).toBe('MyApp-Setup');
  });

  it('includes channel suffix for canary builds', () => {
    expect(getLinuxAppImageBaseName('MyApp', 'canary')).toBe('MyApp-Setup-canary');
  });
});

describe('getLinuxAppImageFileName', () => {
  it('returns full filename with .AppImage extension for stable', () => {
    expect(getLinuxAppImageFileName('MyApp', 'stable')).toBe('MyApp-Setup.AppImage');
  });

  it('returns full filename with .AppImage extension for canary', () => {
    expect(getLinuxAppImageFileName('MyApp', 'canary')).toBe('MyApp-Setup-canary.AppImage');
  });
});

describe('sanitizeVolumeNameForHdiutil', () => {
  it('removes special characters', () => {
    expect(sanitizeVolumeNameForHdiutil('My-App_v1.0')).toBe('MyAppv10');
  });

  it('removes parentheses and other punctuation', () => {
    expect(sanitizeVolumeNameForHdiutil('My App (Beta)')).toBe('My App Beta');
  });

  it('preserves spaces and alphanumerics', () => {
    expect(sanitizeVolumeNameForHdiutil('My App 2024')).toBe('My App 2024');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeVolumeNameForHdiutil('  My App  ')).toBe('My App');
  });

  it('handles names with only special characters', () => {
    expect(sanitizeVolumeNameForHdiutil('---')).toBe('');
  });
});

describe('getDmgVolumeName', () => {
  it('adds -stable suffix for stable builds (to avoid CI volume conflicts)', () => {
    expect(getDmgVolumeName('MyApp', 'stable')).toBe('MyApp-stable');
  });

  it('returns sanitized name for canary builds (already has suffix)', () => {
    expect(getDmgVolumeName('MyApp-canary', 'canary')).toBe('MyAppcanary');
  });

  it('sanitizes special characters', () => {
    expect(getDmgVolumeName('My-App', 'stable')).toBe('MyApp-stable');
  });
});

describe('URL construction functions', () => {
  const bucketUrl = 'https://storage.example.com/releases';
  const platformFolder = 'canary-macos-arm64';

  describe('getUpdateInfoUrl', () => {
    it('constructs correct URL', () => {
      expect(getUpdateInfoUrl(bucketUrl, platformFolder))
        .toBe('https://storage.example.com/releases/canary-macos-arm64/update.json');
    });

    it('handles bucket URLs with trailing content', () => {
      expect(getUpdateInfoUrl('https://example.com/bucket', 'stable-win-x64'))
        .toBe('https://example.com/bucket/stable-win-x64/update.json');
    });
  });

  describe('getPatchFileUrl', () => {
    it('constructs correct URL with hash', () => {
      expect(getPatchFileUrl(bucketUrl, platformFolder, 'abc123def456'))
        .toBe('https://storage.example.com/releases/canary-macos-arm64/abc123def456.patch');
    });
  });

  describe('getTarballUrl', () => {
    it('constructs correct URL for macOS tarball', () => {
      expect(getTarballUrl(bucketUrl, platformFolder, 'MyApp.app.tar.zst'))
        .toBe('https://storage.example.com/releases/canary-macos-arm64/MyApp.app.tar.zst');
    });

    it('constructs correct URL for Windows tarball', () => {
      expect(getTarballUrl(bucketUrl, 'stable-win-x64', 'MyApp.tar.zst'))
        .toBe('https://storage.example.com/releases/stable-win-x64/MyApp.tar.zst');
    });
  });
});

// Integration tests that verify CLI and Updater would produce matching values
describe('CLI and Updater consistency', () => {
  it('produces matching platform folders', () => {
    // CLI uses: `${buildEnvironment}-${currentTarget.os}-${currentTarget.arch}`
    // Updater uses: `${localInfo.channel}-${currentOS}-${currentArch}`
    // Both should use getPlatformFolder()
    const cliResult = getPlatformFolder('canary', 'macos', 'arm64');
    const updaterResult = getPlatformFolder('canary', 'macos', 'arm64');
    expect(cliResult).toBe(updaterResult);
    expect(cliResult).toBe('canary-macos-arm64');
  });

  it('produces matching tarball names for macOS', () => {
    const appFileName = getAppFileName('My App', 'canary');
    const tarballName = getTarballFileName(appFileName, 'macos');
    expect(tarballName).toBe('MyApp-canary.app.tar.zst');
  });

  it('produces matching tarball names for Windows', () => {
    const appFileName = getAppFileName('My App', 'stable');
    const tarballName = getTarballFileName(appFileName, 'win');
    expect(tarballName).toBe('MyApp.tar.zst');
  });

  it('produces matching tarball names for Linux', () => {
    const appFileName = getAppFileName('My App', 'dev');
    const tarballName = getTarballFileName(appFileName, 'linux');
    expect(tarballName).toBe('MyApp-dev.tar.zst');
  });

  it('stable builds have no channel suffix in artifact names', () => {
    // This is the regression test for the -stable bug
    expect(getAppFileName('MyApp', 'stable')).toBe('MyApp');
    expect(getAppFileName('MyApp', 'stable')).not.toContain('-stable');
    expect(getTarballFileName(getAppFileName('MyApp', 'stable'), 'macos')).toBe('MyApp.app.tar.zst');
    expect(getWindowsSetupFileName('MyApp', 'stable')).toBe('MyApp-Setup.exe');
    expect(getLinuxSetupFileName('MyApp', 'stable')).toBe('MyApp-Setup.run');
  });
});
