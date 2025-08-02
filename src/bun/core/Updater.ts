import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { renameSync, unlinkSync, mkdirSync, rmdirSync, statSync } from "fs";
import tar from "tar";
import { ZstdInit } from "@oneidentity/zstd-js/wasm";
import { OS as currentOS, ARCH as currentArch } from '../../shared/platform';

const appSupportDir = join(homedir(), "Library", "Application Support");

// todo (yoav): share type with cli
let localInfo: {
  version: string;
  hash: string;
  bucketUrl: string;
  channel: string;
  name: string;
  identifier: string;
};

let updateInfo: {
  version: string;
  hash: string;
  updateAvailable: boolean;
  updateReady: boolean;
  error: string;
};

const Updater = {
  // workaround for some weird state stuff in this old version of bun
  // todo: revisit after updating to the latest bun
  updateInfo: () => {
    return updateInfo;
  },
  // todo: allow switching channels, by default will check the current channel
  checkForUpdate: async () => {
    const localInfo = await Updater.getLocallocalInfo();

    if (localInfo.channel === "dev") {
      return {
        version: localInfo.version,
        hash: localInfo.hash,
        updateAvailable: false,
        updateReady: false,
        error: "",
      };
    }

    const channelBucketUrl = await Updater.channelBucketUrl();
    const cacheBuster = Math.random().toString(36).substring(7);
    const platformFolder = `${localInfo.channel}-${currentOS}-${currentArch}`;
    const updateInfoUrl = join(localInfo.bucketUrl, platformFolder, `update.json?${cacheBuster}`);

    try {
      const updateInfoResponse = await fetch(updateInfoUrl);

      if (updateInfoResponse.ok) {
        // todo: this seems brittle
        updateInfo = await updateInfoResponse.json();

        if (updateInfo.hash !== localInfo.hash) {
          updateInfo.updateAvailable = true;
        }
      } else {
        return {
          version: "",
          hash: "",
          updateAvailable: false,
          updateReady: false,
          error: `Failed to fetch update info from ${updateInfoUrl}`,
        };
      }
    } catch (error) {
      return {
        version: "",
        hash: "",
        updateAvailable: false,
        updateReady: false,
        error: `Failed to fetch update info from ${updateInfoUrl}`,
      };
    }

    return updateInfo;
  },

  downloadUpdate: async () => {
    const appDataFolder = await Updater.appDataFolder();
    const channelBucketUrl = await Updater.channelBucketUrl();
    const appFileName = localInfo.name;

    let currentHash = (await Updater.getLocallocalInfo()).hash;
    let latestHash = (await Updater.checkForUpdate()).hash;

    const extractionFolder = join(appDataFolder, "self-extraction");
    if (!(await Bun.file(extractionFolder).exists())) {
      mkdirSync(extractionFolder, { recursive: true });
    }

    let currentTarPath = join(extractionFolder, `${currentHash}.tar`);
    const latestTarPath = join(extractionFolder, `${latestHash}.tar`);

    const seenHashes = [];

    // todo (yoav): add a check to the while loop that checks for a hash we've seen before
    // so that update loops that are cyclical can be broken
    if (!(await Bun.file(latestTarPath).exists())) {
      while (currentHash !== latestHash) {
        seenHashes.push(currentHash);
        const currentTar = Bun.file(currentTarPath);

        if (!(await currentTar.exists())) {
          // tar file of the current version not found
          // so we can't patch it. We need the byte-for-byte tar file
          // so break out and download the full version
          break;
        }

        // check if there's a patch file for it
        const platformFolder = `${localInfo.channel}-${currentOS}-${currentArch}`;
        const patchResponse = await fetch(
          join(localInfo.bucketUrl, platformFolder, `${currentHash}.patch`)
        );

        if (!patchResponse.ok) {
          // patch not found
          break;
        }

        // The patch file's name is the hash of the "from" version
        const patchFilePath = join(
          appDataFolder,
          "self-extraction",
          `${currentHash}.patch`
        );
        await Bun.write(patchFilePath, await patchResponse.arrayBuffer());
        // patch it to a tmp name
        const tmpPatchedTarFilePath = join(
          appDataFolder,
          "self-extraction",
          `from-${currentHash}.tar`
        );

        // Note: cwd should be Contents/MacOS/ where the binaries are in the amc app bundle
        try {
          Bun.spawnSync([
            "bspatch",
            currentTarPath,
            tmpPatchedTarFilePath,
            patchFilePath,
          ]);
        } catch (error) {
          break;
        }

        let versionSubpath = "";
        const untarDir = join(appDataFolder, "self-extraction", "tmpuntar");
        mkdirSync(untarDir, { recursive: true });

        // extract just the version.json from the patched tar file so we can see what hash it is now
        const resourcesDir = 'Resources'; // Always use capitalized Resources
        await tar.x({
          // gzip: false,
          file: tmpPatchedTarFilePath,
          cwd: untarDir,
          filter: (path, stat) => {
            if (path.endsWith(`${resourcesDir}/version.json`)) {
              versionSubpath = path;
              return true;
            } else {
              return false;
            }
          },
        });

        const currentVersionJson = await Bun.file(
          join(untarDir, versionSubpath)
        ).json();
        const nextHash = currentVersionJson.hash;

        if (seenHashes.includes(nextHash)) {
          console.log("Warning: cyclical update detected");
          break;
        }

        seenHashes.push(nextHash);

        if (!nextHash) {
          break;
        }
        // Sync the patched tar file to the new hash
        const updatedTarPath = join(
          appDataFolder,
          "self-extraction",
          `${nextHash}.tar`
        );
        renameSync(tmpPatchedTarFilePath, updatedTarPath);

        // delete the old tar file
        unlinkSync(currentTarPath);
        unlinkSync(patchFilePath);
        rmdirSync(untarDir, { recursive: true });

        currentHash = nextHash;
        currentTarPath = join(
          appDataFolder,
          "self-extraction",
          `${currentHash}.tar`
        );
        // loop through applying patches until we reach the latest version
        // if we get stuck then exit and just download the full latest version
      }

      // If we weren't able to apply patches to the current version,
      // then just download it and unpack it
      if (currentHash !== latestHash) {
        const cacheBuster = Math.random().toString(36).substring(7);
        const platformFolder = `${localInfo.channel}-${currentOS}-${currentArch}`;
        const urlToLatestTarball = join(
          localInfo.bucketUrl,
          platformFolder,
          `${appFileName}.app.tar.zst`
        );
        const prevVersionCompressedTarballPath = join(
          appDataFolder,
          "self-extraction",
          "latest.tar.zst"
        );
        const response = await fetch(urlToLatestTarball + `?${cacheBuster}`);

        if (response.ok && response.body) {
          const reader = response.body.getReader();

          const writer = Bun.file(prevVersionCompressedTarballPath).writer();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
          await writer.flush();
          writer.end();
        } else {
          console.log("latest version not found at: ", urlToLatestTarball);
        }

        await ZstdInit().then(async ({ ZstdSimple }) => {
          const data = new Uint8Array(
            await Bun.file(prevVersionCompressedTarballPath).arrayBuffer()
          );
          const uncompressedData = ZstdSimple.decompress(data);

          await Bun.write(latestTarPath, uncompressedData);
        });

        unlinkSync(prevVersionCompressedTarballPath);
        try {
          unlinkSync(currentTarPath);
        } catch (error) {
          // Note: ignore the error. it may have already been deleted by the patching process
          // if the patching process only got halfway
        }
      }
    }

    // Note: Bun.file().exists() caches the result, so we nee d an new instance of Bun.file() here
    // to check again
    if (await Bun.file(latestTarPath).exists()) {
      // download patch for this version, apply it.
      // check for patch from that tar and apply it, until it matches the latest version
      // as a fallback it should just download and unpack the latest version
      updateInfo.updateReady = true;
    } else {
      updateInfo.error = "Failed to download latest version";
    }
  },

  // todo (yoav): this should emit an event so app can cleanup or block the restart
  // todo (yoav): rename this to quitAndApplyUpdate or something
  applyUpdate: async () => {
    if (updateInfo?.updateReady) {
      const appDataFolder = await Updater.appDataFolder();
      const extractionFolder = join(appDataFolder, "self-extraction");
      if (!(await Bun.file(extractionFolder).exists())) {
        mkdirSync(extractionFolder, { recursive: true });
      }

      let latestHash = (await Updater.checkForUpdate()).hash;
      const latestTarPath = join(extractionFolder, `${latestHash}.tar`);

      let appBundleSubpath: string = "";

      if (await Bun.file(latestTarPath).exists()) {
        await tar.x({
          // gzip: false,
          file: latestTarPath,
          cwd: extractionFolder,
          onentry: (entry) => {
            // find the first .app bundle in the tarball
            // Some apps may have nested .app bundles
            if (!appBundleSubpath && entry.path.endsWith(".app/")) {
              appBundleSubpath = entry.path;
            }
          },
        });

        if (!appBundleSubpath) {
          console.error("Failed to find app bundle in tarball");
          return;
        }

        // Note: resolve here removes the extra trailing / that the tar file adds
        const newAppBundlePath = resolve(
          join(extractionFolder, appBundleSubpath)
        );
        // Note: dirname(process.execPath) is the path to the running app bundle's
        // Contents/MacOS directory
        const runningAppBundlePath = resolve(
          dirname(process.execPath),
          "..",
          ".."
        );
        const backupAppBundlePath = join(extractionFolder, "backup.app");

        try {
          // const backupState = statSync(backupAppBundlePath);
          if (statSync(backupAppBundlePath, { throwIfNoEntry: false })) {
            rmdirSync(backupAppBundlePath, { recursive: true });
          } else {
            console.log("backupAppBundlePath does not exist");
          }
          renameSync(runningAppBundlePath, backupAppBundlePath);
          renameSync(newAppBundlePath, runningAppBundlePath);
        } catch (error) {
          console.error("Failed to replace app with new version", error);
          return;
        }

        await Bun.spawn(["open", runningAppBundlePath]);
        process.exit(0);
      }
    }
  },

  channelBucketUrl: async () => {
    await Updater.getLocallocalInfo();
    const platformFolder = `${localInfo.channel}-${currentOS}-${currentArch}`;
    return join(localInfo.bucketUrl, platformFolder);
  },

  appDataFolder: async () => {
    await Updater.getLocallocalInfo();
    const appDataFolder = join(
      appSupportDir,
      localInfo.identifier,
      localInfo.name
    );

    return appDataFolder;
  },

  // TODO: consider moving this from "Updater.localInfo" to "BuildVars"
  localInfo: {
    version: async () => {
      return (await Updater.getLocallocalInfo()).version;
    },
    hash: async () => {
      return (await Updater.getLocallocalInfo()).hash;
    },
    channel: async () => {
      return (await Updater.getLocallocalInfo()).channel;
    },
    bucketUrl: async () => {
      return (await Updater.getLocallocalInfo()).bucketUrl;
    },
  },

  getLocallocalInfo: async () => {
    if (localInfo) {
      return localInfo;
    }

    try {
      const resourcesDir = 'Resources'; // Always use capitalized Resources
      localInfo = await Bun.file(`../${resourcesDir}/version.json`).json();
      return localInfo;
    } catch (error) {
      // Handle the error
      console.error("Failed to read version.json", error);

      // Then rethrow so the app crashes
      throw error;
    }
  },
};

export { Updater };
