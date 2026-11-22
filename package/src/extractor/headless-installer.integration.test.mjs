import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Build the native extractor project, then run this file with node --test.
// Explicit binary overrides let release CI test its exact staged artifacts.
// Windows registration uses real known folders and HKCU, so that platform must
// run as a disposable test user, not merely with redirected environment paths.
const directory = dirname(fileURLToPath(import.meta.url));
const extension = process.platform === "win32" ? ".exe" : "";
const installer = resolve(process.env.ELECTROBUN_TEST_HEADLESS_INSTALLER || join(directory, "zig-out", "bin", `headless-installer${extension}`));
const extractor = resolve(process.env.ELECTROBUN_TEST_EXTRACTOR || join(directory, "zig-out", "bin", `extractor${extension}`));
const platform = { darwin: "macos", linux: "linux", win32: "win" }[process.platform];
const arch = { arm64: "arm64", x64: "x64" }[process.arch];
const windowsAllowed = process.platform !== "win32" || process.env.ELECTROBUN_TEST_DISPOSABLE_WINDOWS_USER === "1";
const skipReason = !platform || !arch ? "unsupported native target"
  : !windowsAllowed ? "Windows requires ELECTROBUN_TEST_DISPOSABLE_WINDOWS_USER=1 in a disposable user/VM"
    : !existsSync(installer) || !existsSync(extractor) ? "build the headless-installer and extractor native binaries first" : false;
if (process.env.ELECTROBUN_REQUIRE_HEADLESS_INSTALLER === "1") assert.equal(skipReason, false);

const slotStart = Buffer.from("ELECTROBUN_HEADLESS_CONFIG_V1_START");
const slotEnd = Buffer.from("ELECTROBUN_HEADLESS_CONFIG_V1_END");
const slotCapacity = 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function tar(entries) {
  const chunks = [];
  for (const { path, bytes = Buffer.alloc(0), mode = 0o644, directory = false } of entries) {
    const header = Buffer.alloc(512);
    assert.ok(Buffer.byteLength(path) <= 100, `fixture tar path is too long: ${path}`);
    header.write(path, 0, 100);
    const octal = (value, offset, size) => header.write(value.toString(8).padStart(size - 1, "0") + "\0", offset, size);
    octal(mode, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(bytes.length, 124, 12);
    octal(1_700_000_000, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = directory ? 0x35 : 0x30;
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

// A valid Zstd frame made entirely of raw blocks. This intentionally needs no
// system zstd/tar command or additional JS package. Its declared window is
// 128 KiB and its four-byte content size covers the complete uncompressed tar.
function rawZstd(bytes) {
  const header = Buffer.alloc(10);
  header.writeUInt32LE(0xfd2fb528, 0);
  header[4] = 0x80;
  header[5] = 0x38;
  header.writeUInt32LE(bytes.length, 6);
  const chunks = [header];
  for (let offset = 0; offset < bytes.length; offset += 128 * 1024) {
    const block = bytes.subarray(offset, offset + 128 * 1024);
    const blockHeader = Buffer.alloc(3);
    blockHeader.writeUIntLE((block.length << 3) | (offset + block.length === bytes.length ? 1 : 0), 0, 3);
    chunks.push(blockHeader, block);
  }
  return Buffer.concat(chunks);
}

async function configuredInstaller(destination, config) {
  const binary = await readFile(installer);
  const slots = [];
  for (let offset = binary.indexOf(slotStart); offset !== -1; offset = binary.indexOf(slotStart, offset + 1)) {
    const end = offset + slotStart.length + 8 + slotCapacity;
    if (binary.subarray(end, end + slotEnd.length).equals(slotEnd)) slots.push(offset);
  }
  assert.equal(slots.length, 1, "native installer must expose exactly one reserved config slot");
  const payload = Buffer.from(JSON.stringify(config));
  assert.ok(payload.length <= slotCapacity);
  const offset = slots[0] + slotStart.length;
  binary.writeBigUInt64LE(BigInt(payload.length), offset);
  binary.fill(0, offset + 8, offset + 8 + slotCapacity);
  payload.copy(binary, offset + 8);
  await writeFile(destination, binary, { mode: 0o755 });
  await chmod(destination, 0o755);
  if (process.platform === "darwin") {
    const result = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", destination], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const verification = spawnSync("/usr/bin/codesign", ["--verify", "--strict", destination], { encoding: "utf8" });
    assert.ifError(verification.error);
    assert.equal(verification.status, 0, verification.stderr);
  }
}

function execute(command, args, env, input = "") {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 45_000);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    // Invalid arguments may cause the child to exit before it reads stdin.
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`installer timed out: ${stderr}`));
      else resolvePromise({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function assertRecipe(root, appPath, release) {
  const bytes = await readFile(join(root, "self-extraction", `${release.hash}.recipe.json`));
  const recipe = JSON.parse(bytes);
  assert.equal(recipe.schema_version, 1);
  assert.equal(recipe.archive_size, release.tar.length);
  assert.equal(recipe.archive_sha256, sha256(release.tar));
  const chunks = [];
  for (const span of recipe.spans) {
    const bytes = span.literal_hex != null ? Buffer.from(span.literal_hex, "hex") : await readFile(join(appPath, span.path));
    assert.equal(bytes.length, span.size);
    chunks.push(bytes);
  }
  assert.deepEqual(Buffer.concat(chunks), release.tar, "retained recipe reconstructs the exact updater baseline");
  return bytes;
}

test("unattended installer verifies releases and preserves private settings without launching the app", {
  skip: skipReason, timeout: 300_000,
}, async t => {
  // /var on macOS is a symlink; the installer correctly refuses a symlink in
  // its canonical hierarchy, so start from the real temporary directory.
  const sandbox = await mkdtemp(join(await realpath(tmpdir()), "electrobun-headless-test-"));
  const identitySuffix = `${process.pid}.${randomBytes(5).toString("hex")}`;
  const identifier = `org.electrobun.test.headless.${identitySuffix}`;
  const name = `Headless Fixture ${identitySuffix}`;
  const channel = "canary";
  const prefix = `${channel}-${platform}-${arch}`;
  const home = join(sandbox, "home");
  const data = join(sandbox, "data");
  const appData = join(sandbox, "roaming");
  const sentinel = join(sandbox, "app-was-launched");
  const executable = join(sandbox, `Headless-Setup${extension}`);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: data, APPDATA: appData,
    XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(sandbox, "config"), XDG_CACHE_HOME: join(sandbox, "cache"),
    XDG_STATE_HOME: join(sandbox, "state"), TMPDIR: join(sandbox, "tmp"), TMP: join(sandbox, "tmp"), TEMP: join(sandbox, "tmp"),
    HEADLESS_LAUNCH_SENTINEL: sentinel,
  };
  delete env.ELECTROBUN_INSTALL_ROOT_NAME;
  delete env.ELECTROBUN_INSTALLER_UI_PREVIEW;
  delete env.NODE_OPTIONS;
  await Promise.all([home, data, appData, env.TMPDIR].map(path => mkdir(path, { recursive: true })));
  const userData = process.platform === "darwin" ? join(home, "Library", "Application Support", identifier, channel) : join(data, identifier, channel);
  const resources = process.platform === "darwin" ? "Contents/Resources" : "Resources";
  const launchPath = process.platform === "darwin" ? "Contents/MacOS/launcher" : `bin/launcher${extension}`;
  const bundleName = process.platform === "darwin" ? "HeadlessFixture-canary.app" : "HeadlessFixture-canary";
  const expectedAppPath = join(userData, process.platform === "darwin" ? bundleName : "app");
  const versionPath = join(expectedAppPath, resources, "version.json");
  const settingsPath = join(userData, "install.json");
  const managerBytes = await readFile(extractor);
  let launcherBytes = Buffer.from('#!/bin/sh\nprintf launched > "$HEADLESS_LAUNCH_SENTINEL"\n');
  if (process.platform === "win32") {
    launcherBytes = await readFile(process.execPath);
    const launchHook = join(sandbox, "launch-hook.cjs");
    await writeFile(launchHook, "require('node:fs').writeFileSync(process.env.HEADLESS_LAUNCH_SENTINEL, 'launched'); process.exit(0);\n");
    env.NODE_OPTIONS = `--require="${launchHook.replaceAll("\\", "/")}"`;
  }
  const requests = [];
  let selected;
  let transientManifest;
  let holdNextArchive;
  const server = createServer((request, response) => {
    requests.push(request.url);
    const path = decodeURIComponent(new URL(request.url, "http://fixture").pathname);
    const body = path === `/releases/${prefix}-update.json` ? Buffer.from(JSON.stringify(transientManifest || selected.manifest))
      : path === `/releases/${prefix}-checksum.json` ? Buffer.from(JSON.stringify(selected.checksum))
        : path === `/releases/${selected.manifest.artifact.file}` ? selected.compressed : undefined;
    if (path === `/releases/${prefix}-update.json`) transientManifest = undefined;
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Length": body.length, "Content-Type": "application/octet-stream" });
    if (path === `/releases/${selected.manifest.artifact.file}` && holdNextArchive) {
      const release = holdNextArchive;
      holdNextArchive = undefined;
      release({ response, body });
      return;
    }
    response.end(body);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/releases/`;
  const defaults = { startup: { openWindow: true, showTray: true }, list: [1], nested: { fromDefault: true }, nullable: "default" };
  const secretFile = `file-secret-${randomBytes(12).toString("hex")}`;
  const secretStdin = `stdin-secret-${randomBytes(12).toString("hex")}`;
  const failedSecret = `never-committed-${randomBytes(12).toString("hex")}`;
  function release(hash, version = "1.0.0", payloadOverrides = {}) {
    const metadata = { name, identifier, channel, hash, version, baseUrl, ...payloadOverrides };
    const entries = [{ path: bundleName, directory: true, mode: 0o755 }];
    for (const path of process.platform === "darwin" ? ["Contents", "Contents/MacOS", "Contents/Resources"] : ["bin", "Resources"]) {
      entries.push({ path: `${bundleName}/${path}`, directory: true, mode: 0o755 });
    }
    if (process.platform === "darwin") {
      entries.push({ path: `${bundleName}/Contents/Info.plist`, bytes: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>` +
        `<key>CFBundleIdentifier</key><string>${metadata.identifier}</string>` +
        `<key>CFBundleExecutable</key><string>launcher</string>` +
        `<key>CFBundleName</key><string>Headless Fixture</string>` +
        `<key>CFBundlePackageType</key><string>APPL</string>` +
        `<key>CFBundleVersion</key><string>${version}</string></dict></plist>`,
      ) });
    }
    entries.push(
      { path: `${bundleName}/${launchPath}`, bytes: launcherBytes, mode: 0o755 },
      { path: `${bundleName}/${resources}/uninstall`, bytes: managerBytes, mode: 0o755 },
      { path: `${bundleName}/${resources}/version.json`, bytes: Buffer.from(JSON.stringify(metadata)) },
    );
    const archive = tar(entries);
    const artifact = `${prefix}-${bundleName}.tar.zst`;
    return {
      hash, tar: archive, compressed: rawZstd(archive),
      manifest: { schemaVersion: 1, identifier, channel, hash, version, platform, arch, artifact: { file: artifact } },
      checksum: { hash, tarSha256: sha256(archive), tarSize: archive.length },
    };
  }
  async function run(args = [], input = "", binary = executable) {
    const result = await execute(binary, ["--json", ...args], env, input);
    assert.equal(result.signal, null, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, `--json must produce exactly one result: ${result.stdout}`);
    const status = JSON.parse(lines[0]);
    assert.equal(status.schemaVersion, 1);
    for (const secret of [secretFile, secretStdin, failedSecret]) {
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), "installer output must not reveal caller settings");
    }
    assert.equal(existsSync(sentinel), false, "unattended installation must never launch the app");
    return { ...result, status };
  }
  try {
    selected = release("initial001");
    const initial = selected;
    const config = { schemaVersion: 1, name, identifier, channel, baseUrl, platform, arch, defaults };
    await configuredInstaller(executable, config);
    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.equal(help.status.status, "help");
    assert.equal((await run(["--launch"])).code, 2, "installation does not expose a launch switch");
    const wrongTargetPath = join(sandbox, `Wrong-Target-Setup${extension}`);
    await configuredInstaller(wrongTargetPath, { ...config, platform: platform === "macos" ? "linux" : "macos" });
    const wrongTarget = await execute(wrongTargetPath, ["--json"], env);
    assert.equal(wrongTarget.code, 1);
    assert.deepEqual(JSON.parse(wrongTarget.stdout), {
      schemaVersion: 1, success: false, status: "failed", phase: "configuration", error: "InstallerTargetMismatch", exitCode: 1,
    });
    assert.equal(requests.length, 0, "help/argument/target validation must not fetch a release");
    const settingsFile = join(sandbox, "private settings.json");
    await writeFile(settingsFile, `{"startup":{"openWindow":false},"token":"${secretFile}","counter":9007199254740993,"list":[2,3],"nullable":null}`, { mode: 0o600 });
    const first = await run(["--settings-file", settingsFile]);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.status, {
      schemaVersion: 1, success: true, status: "installed", identifier, channel, version: "1.0.0", hash: initial.hash,
      userData, appPath: expectedAppPath, launcherPath: join(expectedAppPath, launchPath), settingsPath,
    });
    assert.ok(requests.includes(`/releases/${prefix}-update.json`));
    assert.ok(requests.includes(`/releases/${prefix}-checksum.json`));
    assert.ok(requests.includes(`/releases/${initial.manifest.artifact.file}`));
    let settingsBytes = await readFile(settingsPath, "utf8");
    let settings = JSON.parse(settingsBytes);
    assert.deepEqual(settings.settings.startup, { openWindow: false, showTray: true });
    assert.deepEqual(settings.settings.list, [2, 3]);
    assert.deepEqual(settings.settings.nested, { fromDefault: true });
    assert.equal(settings.settings.nullable, null);
    assert.equal(settings.settings.token, secretFile);
    assert.match(settingsBytes, /"counter":9007199254740993\b/, "settings transfer must preserve numbers beyond JS integer precision");
    if (process.platform !== "win32") {
      assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
      assert.equal((await stat(userData)).mode & 0o777, 0o700);
    }
    await assertRecipe(userData, expectedAppPath, initial);
    const registration = JSON.parse(await readFile(join(userData, ".electrobun-uninstall.json"), "utf8"));
    assert.equal(registration.identifier, identifier);
    assert.equal(registration.channel, channel);

    // Preserve the exact prior bytes, including formatting chosen by the app.
    settingsBytes += "\n";
    await writeFile(settingsPath, settingsBytes);
    const repeat = await run();
    assert.equal(repeat.code, 0, repeat.stderr);
    assert.equal(await readFile(settingsPath, "utf8"), settingsBytes);

    const fromStdin = await run(["--settings-stdin"], JSON.stringify({ startup: { showTray: false }, token: secretStdin, list: [9], fromStdin: true }));
    assert.equal(fromStdin.code, 0, fromStdin.stderr);
    settingsBytes = await readFile(settingsPath, "utf8");
    settings = JSON.parse(settingsBytes);
    assert.deepEqual(settings.settings.startup, { openWindow: false, showTray: false });
    assert.deepEqual(settings.settings.list, [9]);
    assert.equal(settings.settings.token, secretStdin);
    assert.equal(settings.settings.fromStdin, true);
    assert.match(settingsBytes, /"counter":9007199254740993\b/);
    const oldVersion = await readFile(versionPath);
    const oldRecipe = await assertRecipe(userData, expectedAppPath, initial);
    async function unchanged() {
      assert.deepEqual(await readFile(versionPath), oldVersion, "failed installation must preserve the installed release");
      assert.equal(await readFile(settingsPath, "utf8"), settingsBytes, "failed installation must preserve caller settings");
      assert.deepEqual(await readFile(join(userData, "self-extraction", `${initial.hash}.recipe.json`)), oldRecipe);
    }

    if (process.platform !== "win32") {
      // Receiving the artifact request proves the installer acquired its lock;
      // keep that request open while attempting a competing quiet uninstall.
      let releaseDownload;
      const waitingForDownload = new Promise(resolvePromise => { holdNextArchive = resolvePromise; });
      const installing = run();
      try {
        releaseDownload = await Promise.race([
          waitingForDownload,
          installing.then(() => { throw new Error("installer completed before the controlled download"); }),
        ]);
        const blockedUninstall = await execute(join(userData, "uninstall"), ["--quiet"], env);
        assert.notEqual(blockedUninstall.code, 0, "uninstall must not delete a baseline locked by an installer");
        assert.match(blockedUninstall.stderr, /InstallationBusy/);
        await unchanged();
      } finally {
        holdNextArchive = undefined;
        if (releaseDownload) releaseDownload.response.end(releaseDownload.body);
        const completedInstall = await installing;
        assert.equal(completedInstall.code, 0, completedInstall.stderr);
      }
      await unchanged();
    }

    // A name that resembles the installer's rollback directory does not prove
    // ownership. Reject unrelated contents instead of deleting them on retry.
    const foreignPrevious = `${expectedAppPath}.previous`;
    const foreignSentinel = join(foreignPrevious, "unrelated-data");
    await mkdir(foreignPrevious);
    await writeFile(foreignSentinel, "must remain intact");
    const unrelatedPrevious = await run();
    assert.equal(unrelatedPrevious.code, 1);
    assert.equal(unrelatedPrevious.status.success, false);
    assert.equal(await readFile(foreignSentinel, "utf8"), "must remain intact");
    await unchanged();
    await rm(foreignPrevious, { recursive: true });

    if (process.platform === "darwin") {
      // Existing bundle paths require a valid registration token, even when
      // the path still names this fixture app.
      const manifestPath = join(userData, ".electrobun-uninstall.json");
      const manifestBytes = await readFile(manifestPath);
      const tampered = JSON.parse(manifestBytes);
      assert.equal(typeof tampered.app_path_token, "string");
      tampered.app_path_token = (tampered.app_path_token[0] === "0" ? "1" : "0") + tampered.app_path_token.slice(1);
      await writeFile(manifestPath, JSON.stringify(tampered));
      const tamperedRegistration = await run();
      assert.equal(tamperedRegistration.code, 1);
      assert.equal(tamperedRegistration.status.success, false);
      await unchanged();
      await writeFile(manifestPath, manifestBytes);
    }

    selected = release("badsha002", "2.0.0");
    selected.checksum.tarSha256 = "0".repeat(64);
    const badSha = await run(["--settings-stdin"], JSON.stringify({ token: failedSecret }));
    assert.equal(badSha.code, 1);
    assert.equal(badSha.status.success, false);
    assert.equal(badSha.status.error, "InstallArchiveIntegrityMismatch");
    assert.equal(badSha.status.exitCode, 1);
    await unchanged();

    selected = release("badid003", "2.0.0", { identifier: "org.electrobun.test.wrong" });
    const badIdentity = await run(["--settings-stdin"], JSON.stringify({ token: failedSecret }));
    assert.equal(badIdentity.code, 1);
    assert.equal(badIdentity.status.error, "InstallPayloadIdentityMismatch");
    await unchanged();

    selected = release("badmeta004", "2.0.0");
    selected.manifest.identifier = "org.electrobun.test.wrong";
    const beforeManifest = requests.length;
    const badManifest = await run();
    assert.equal(badManifest.code, 1);
    assert.equal(badManifest.status.error, "UpdateIdentityMismatch");
    assert.deepEqual(requests.slice(beforeManifest), [`/releases/${prefix}-update.json`]);
    await unchanged();

    const beforeInvalidSettings = requests.length;
    const invalidJson = await run(["--settings-stdin"], `{"token":"${failedSecret}"`);
    assert.equal(invalidJson.code, 2);
    assert.equal(invalidJson.status.error, "InvalidSettingsJson");
    const invalidObject = await run(["--settings-stdin"], "[]");
    assert.equal(invalidObject.code, 2);
    assert.equal(invalidObject.status.error, "InvalidSettingsObject");
    const invalidArguments = await run(["--settings-file", settingsFile, "--settings-stdin"]);
    assert.equal(invalidArguments.code, 2);
    assert.equal(invalidArguments.status.error, "InvalidArguments");
    assert.equal(requests.length, beforeInvalidSettings, "invalid settings/arguments must fail before network activity");
    await unchanged();

    if (process.platform === "darwin") {
      // Fail after the validated app and recipe have been swapped into place.
      // A directory at the manager's atomic replacement target prevents OS
      // registration and must roll the installed app and updater baseline back.
      const managerPath = join(userData, "uninstall");
      await rm(managerPath);
      await mkdir(managerPath);
      selected = release("badreg005", "2.0.0");
      const failedRegistration = await run(["--settings-stdin"], JSON.stringify({ token: failedSecret }));
      assert.equal(failedRegistration.code, 1);
      assert.equal(failedRegistration.status.phase, "installing");
      await unchanged();
      await rm(managerPath, { recursive: true });
      selected = initial;
      const recovery = await run();
      assert.equal(recovery.code, 0, recovery.stderr);
      await unchanged();
      assert.equal((await stat(managerPath)).isFile(), true);

      // A first installation has no prior settings to restore. Failed OS
      // registration must remove its newly written private settings and app.
      const freshIdentifier = `${identifier}.fresh`;
      const freshRoot = join(home, "Library", "Application Support", freshIdentifier, channel);
      const freshManager = join(freshRoot, "uninstall");
      await mkdir(freshManager, { recursive: true });
      await writeFile(join(freshManager, "unrelated-data"), "keep");
      const freshExecutable = join(sandbox, "Fresh-Headless-Setup");
      await configuredInstaller(freshExecutable, { ...config, identifier: freshIdentifier });
      selected = release("freshbad007", "1.0.0", { identifier: freshIdentifier });
      selected.manifest.identifier = freshIdentifier;
      const failedFresh = await run(["--settings-stdin"], JSON.stringify({ token: failedSecret }), freshExecutable);
      assert.equal(failedFresh.code, 1);
      assert.equal(failedFresh.status.phase, "installing");
      assert.equal(existsSync(join(freshRoot, "install.json")), false);
      assert.equal(existsSync(join(freshRoot, bundleName)), false);
      assert.equal(existsSync(join(freshRoot, "self-extraction")), false);
      assert.equal(existsSync(join(freshRoot, ".electrobun-uninstall.json")), false);
      assert.equal(await readFile(join(freshManager, "unrelated-data"), "utf8"), "keep");
    }

    // A publisher may replace fixed-name manifest/checksum files separately.
    // The first pair is inconsistent; the second binds the complete new tar.
    selected = release("updated006", "2.0.0");
    transientManifest = initial.manifest;
    const beforeRace = requests.length;
    const updated = await run();
    assert.equal(updated.code, 0, updated.stderr);
    assert.equal(updated.status.hash, selected.hash);
    assert.deepEqual(requests.slice(beforeRace), [
      `/releases/${prefix}-update.json`, `/releases/${prefix}-checksum.json`,
      `/releases/${prefix}-update.json`, `/releases/${prefix}-checksum.json`,
      `/releases/${selected.manifest.artifact.file}`,
    ]);
    assert.equal(await readFile(settingsPath, "utf8"), settingsBytes);
    assert.equal(JSON.parse(await readFile(versionPath, "utf8")).version, "2.0.0");
    await assertRecipe(userData, expectedAppPath, selected);
  } finally {
    try {
      if (process.platform === "win32" && existsSync(join(userData, "uninstall.exe"))) {
        const cleanup = await execute(join(userData, "uninstall.exe"), ["--quiet", "--delete-data"], env);
        assert.equal(cleanup.code, 0, `disposable-user registration cleanup failed: ${cleanup.stderr}`);
      }
    } finally {
      await new Promise(resolvePromise => server.close(resolvePromise));
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  t.diagnostic(`Validated native ${platform}-${arch} full archive install, settings transfer, retained updater baseline, and rollback.`);
});
