import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Exercise the real graphical extractor entrypoint and installed native
// uninstaller. The tiny application only records its launch; it does not need
// a separately built SDK or CEF. The wrapper formats are the normal Linux
// embedded package and Windows adjacent .installer payload, not headless CLI.
const directory = dirname(fileURLToPath(import.meta.url));
const windows = process.platform === "win32";
const linux = process.platform === "linux";
const extension = windows ? ".exe" : "";
const extractor = resolve(process.env.ELECTROBUN_TEST_EXTRACTOR || join(directory, "zig-out", "bin", `extractor${extension}`));
const skipReason = !linux && !windows ? "this normal-installer regression targets Linux and Windows"
  : !["x64", "arm64"].includes(process.arch) ? "unsupported native architecture"
    : windows && process.env.ELECTROBUN_TEST_DISPOSABLE_WINDOWS_USER !== "1" ? "Windows requires a disposable test user/VM"
      : !existsSync(extractor) ? "build the native extractor first"
        : linux && !process.env.DISPLAY ? "Linux requires a live X display and Zenity" : false;
if (process.env.ELECTROBUN_REQUIRE_NORMAL_INSTALLER === "1") assert.equal(skipReason, false);

const sha256 = value => createHash("sha256").update(value).digest("hex");

function tar(entries) {
  const chunks = [];
  for (const { path, bytes = Buffer.alloc(0), mode = 0o644, directory = false } of entries) {
    const header = Buffer.alloc(512);
    assert.ok(Buffer.byteLength(path) <= 100, `fixture tar path is too long: ${path}`);
    header.write(path, 0, 100);
    const octal = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);
    octal(mode, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(bytes.length, 124, 12);
    octal(1_700_000_000, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = directory ? 0x35 : 0x30;
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

// Raw Zstd blocks provide a valid native decoder input without preinstalled
// zstd/tar tools or an extra JS compression dependency.
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

async function waitFor(label, predicate, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function execute(command, args, env, commands, label) {
  return new Promise((resolvePromise, reject) => {
    const record = { label, command, args, started: new Date().toISOString(), stdout: "", stderr: "" };
    commands.push(record);
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 90_000);
    child.stdout.setEncoding("utf8").on("data", chunk => { record.stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { record.stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); record.error = String(error); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      Object.assign(record, { code, signal, finished: new Date().toISOString() });
      if (timedOut) reject(new Error(`${label} timed out:\n${record.stderr}`));
      else resolvePromise(record);
    });
  });
}

async function assertRecipe(root, app, archive, hash) {
  const recipe = JSON.parse(await readFile(join(root, "self-extraction", `${hash}.recipe.json`), "utf8"));
  assert.equal(recipe.schema_version, 1);
  assert.equal(recipe.archive_size, archive.length);
  assert.equal(recipe.archive_sha256, sha256(archive));
  const chunks = [];
  for (const span of recipe.spans) {
    const bytes = span.literal_hex != null ? Buffer.from(span.literal_hex, "hex") : await readFile(join(app, span.path));
    assert.equal(bytes.length, span.size);
    chunks.push(bytes);
  }
  assert.deepEqual(Buffer.concat(chunks), archive, "normal install must retain an exact updater baseline");
}

test("graphical installer creates a missing profile and preserves data through native uninstall", {
  skip: skipReason, timeout: 360_000,
}, async t => {
  if (linux) {
    for (const [command, args] of [["xdpyinfo", []], ["zenity", ["--version"]]]) {
      const prerequisite = spawnSync(command, args, { encoding: "utf8" });
      assert.ifError(prerequisite.error);
      assert.equal(prerequisite.status, 0, `${command} must work on the test desktop: ${prerequisite.stderr}`);
    }
    const dialog = spawnSync("zenity", ["--info", "--timeout=1", "--text=Electrobun normal installer graphical preflight"], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(dialog.error);
    assert.ok([0, 5].includes(dialog.status), `Zenity must open a real dialog and close on timeout: ${dialog.stderr}`);
  }
  const sandbox = await mkdtemp(join(await realpath(tmpdir()), "electrobun-normal-installer-"));
  const token = randomBytes(6).toString("hex");
  const identifier = `org.electrobun.test.normal.${token}`;
  const name = `NormalInstallerFixture-${token}`;
  const channel = "canary";
  const hash = "fixture1";
  const bundle = `${name}-${channel}`;
  const home = join(sandbox, "home");
  const absentProfile = join(sandbox, "missing-profile");
  const data = join(absentProfile, "local", "share");
  const root = join(data, identifier, channel);
  const app = join(root, "app");
  const manager = join(root, `uninstall${extension}`);
  const sentinel = join(sandbox, "launcher-ran");
  const zenityLog = join(sandbox, "zenity-arguments");
  const marker = join(root, "keep-user-data.txt");
  const setup = join(sandbox, `${name}-Setup${extension}`);
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, LOCALAPPDATA: data, APPDATA: join(sandbox, "roaming"),
    XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_CACHE_HOME: join(sandbox, "cache"), XDG_STATE_HOME: join(sandbox, "state"),
    TMPDIR: join(sandbox, "tmp"), TEMP: join(sandbox, "tmp"), TMP: join(sandbox, "tmp"),
    ELECTROBUN_INSTALLER_UI_AUTOCLOSE: "1", NORMAL_INSTALLER_LAUNCH_SENTINEL: sentinel,
  };
  delete env.ELECTROBUN_INSTALL_ROOT_NAME;
  delete env.ELECTROBUN_INSTALLER_UI_PREVIEW;
  delete env.NODE_OPTIONS;
  await Promise.all([join(home, "Desktop"), env.TMPDIR].map(path => mkdir(path, { recursive: true })));
  if (linux) {
    const realZenity = process.env.PATH.split(delimiter).map(path => join(path, "zenity")).find(path => existsSync(path));
    assert.ok(realZenity, "Zenity must be available on PATH");
    const tools = join(sandbox, "tools");
    await mkdir(tools);
    await writeFile(join(tools, "zenity"), '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$NORMAL_INSTALLER_ZENITY_LOG"\nexec "$NORMAL_INSTALLER_REAL_ZENITY" "$@"\n', { mode: 0o755 });
    env.PATH = `${tools}${delimiter}${env.PATH}`;
    env.NORMAL_INSTALLER_ZENITY_LOG = zenityLog;
    env.NORMAL_INSTALLER_REAL_ZENITY = await realpath(realZenity);
  }

  let launcher = Buffer.from('#!/bin/sh\nprintf launched > "$NORMAL_INSTALLER_LAUNCH_SENTINEL"\n');
  if (windows) {
    launcher = await readFile(process.execPath);
    const hook = join(sandbox, "launcher-hook.cjs");
    await writeFile(hook, "require('node:fs').writeFileSync(process.env.NORMAL_INSTALLER_LAUNCH_SENTINEL, 'launched'); process.exit(0);\n");
    env.NODE_OPTIONS = `--require="${hook.replaceAll("\\", "/")}"`;
  }
  const extractorBytes = await readFile(extractor);
  const version = { identifier, name, channel, hash, version: "1.0.0", baseUrl: "https://example.invalid/normal-installer-fixture" };
  const entries = [
    { path: bundle, directory: true, mode: 0o755 },
    { path: `${bundle}/bin`, directory: true, mode: 0o755 },
    { path: `${bundle}/Resources`, directory: true, mode: 0o755 },
    { path: `${bundle}/bin/launcher${extension}`, bytes: launcher, mode: 0o755 },
    { path: `${bundle}/Resources/uninstall`, bytes: extractorBytes, mode: 0o755 },
    { path: `${bundle}/Resources/version.json`, bytes: Buffer.from(JSON.stringify(version)) },
  ];
  if (linux) entries.push({
    path: `${bundle}/${name}.desktop`, mode: 0o755,
    bytes: Buffer.from(`[Desktop Entry]\nType=Application\nName=${name}\nExec=launcher\nTerminal=false\n`),
  });
  const archive = tar(entries);
  const compressed = rawZstd(archive);
  const metadata = Buffer.from(JSON.stringify({ identifier, name, channel, hash }));
  if (windows) {
    await writeFile(setup, extractorBytes);
    const adjacent = join(sandbox, ".installer");
    await mkdir(adjacent);
    await writeFile(join(adjacent, `${name}-Setup.metadata.json`), metadata);
    await writeFile(join(adjacent, `${name}-Setup.tar.zst`), compressed);
  } else {
    await writeFile(setup, Buffer.concat([extractorBytes, Buffer.from("ELECTROBUN_METADATA_V1"), metadata, Buffer.from("ELECTROBUN_ARCHIVE_V1"), compressed]), { mode: 0o755 });
    await chmod(setup, 0o755);
  }

  const commands = [];
  const report = { platform: process.platform, arch: process.arch, extractor, extractorSha256: sha256(extractorBytes), identifier, root, setup, commands };
  const diagnostics = join(process.env.RUNNER_TEMP || await realpath(tmpdir()), `normal-installer-diagnostics-${process.platform}-${process.arch}-${token}`);
  const registryKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${identifier}.${channel}`;
  const reg = windows ? join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe") : undefined;
  const run = (command, args, label) => execute(command, args, env, commands, label);
  async function checkRegistration() {
    const manifest = JSON.parse(await readFile(join(root, ".electrobun-uninstall.json"), "utf8"));
    assert.equal(manifest.identifier, identifier);
    assert.equal(manifest.name, name);
    assert.equal(manifest.channel, channel);
    assert.ok(existsSync(manager));
    if (windows) {
      for (const path of [manifest.desktop_shortcut, manifest.start_menu_shortcut]) assert.ok(path && existsSync(path), `missing registered shortcut: ${path}`);
      const registration = await run(reg, ["query", registryKey, "/v", "InstallLocation", "/reg:64"], "query install registration");
      assert.equal(registration.code, 0, registration.stderr);
      const installedPath = registration.stdout.match(/\sInstallLocation\s+REG_SZ\s+([^\r\n]+)/)?.[1].trim();
      assert.equal(installedPath?.toLowerCase(), app.toLowerCase());
    } else {
      assert.equal(manifest.application_entry, join(data, "applications", `${name}.desktop`));
      assert.equal(manifest.desktop_entry, join(home, "Desktop", `${name}.desktop`));
      for (const path of [manifest.application_entry, manifest.desktop_entry]) assert.ok(existsSync(path), `missing registered desktop entry: ${path}`);
    }
    return manifest;
  }
  async function install(label) {
    await rm(sentinel, { force: true });
    await rm(zenityLog, { force: true });
    const result = await run(setup, [], label);
    assert.equal(result.code, 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
    assert.ok(!result.stderr.includes(`Installing ${name}...`), "normal installer fell back from its graphical progress renderer");
    if (linux) assert.match(await readFile(zenityLog, "utf8"), /^--progress$/m, "normal installer must invoke the real Zenity progress renderer");
    await waitFor("normal installer to launch its installed application", () => existsSync(sentinel));
    assert.equal(await readFile(sentinel, "utf8"), "launched");
    assert.deepEqual(JSON.parse(await readFile(join(app, "Resources", "version.json"), "utf8")), version);
    await assertRecipe(root, app, archive, hash);
    return checkRegistration();
  }
  async function uninstall(manifest, deleteData) {
    const result = await run(manager, deleteData ? ["--quiet", "--delete-data"] : ["--quiet"], deleteData ? "uninstall application and data" : "uninstall application only");
    assert.equal(result.code, 0, `uninstall failed:\n${result.stdout}\n${result.stderr}`);
    await waitFor("native uninstall to remove the application and manager", () => !existsSync(app) && !existsSync(manager));
    assert.equal(existsSync(join(root, "self-extraction")), false);
    assert.equal(existsSync(join(root, ".electrobun-uninstall.json")), false);
    for (const path of windows ? [manifest.desktop_shortcut, manifest.start_menu_shortcut] : [manifest.application_entry, manifest.desktop_entry]) {
      assert.equal(existsSync(path), false, `uninstall left registered integration: ${path}`);
    }
    if (windows) {
      const registration = await run(reg, ["query", registryKey, "/reg:64"], "verify removed install registration");
      assert.notEqual(registration.code, 0, "uninstall left an Installed Apps registration");
    }
    if (deleteData) await waitFor("delete-data uninstall to remove its channel root", () => !existsSync(root));
    else assert.equal(await readFile(marker, "utf8"), "preserved user data");
  }

  try {
    assert.equal(existsSync(absentProfile), false, "fixture must start before any normal-install profile directory exists");
    assert.equal(existsSync(data), false);
    assert.equal(existsSync(root), false);
    const firstManifest = await install("first graphical install with absent profile");
    await writeFile(marker, "preserved user data");
    await uninstall(firstManifest, false);
    const secondManifest = await install("graphical reinstall preserving user data");
    assert.equal(await readFile(marker, "utf8"), "preserved user data");
    await uninstall(secondManifest, true);
    report.success = true;
  } catch (error) {
    report.error = error.stack || String(error);
    throw error;
  } finally {
    if (existsSync(manager)) {
      try {
        const cleanup = await run(manager, ["--quiet", "--delete-data"], "cleanup failed fixture");
        if (cleanup.code !== 0) report.cleanupError = cleanup.stderr || `exit ${cleanup.code}`;
        else await waitFor("fixture cleanup", () => !existsSync(root));
      } catch (error) { report.cleanupError = String(error); }
    }
    await mkdir(diagnostics, { recursive: true });
    await writeFile(join(diagnostics, "report.json"), JSON.stringify(report, null, 2));
    t.diagnostic(`normal installer diagnostics: ${diagnostics}`);
    if (report.success && !report.cleanupError) await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    else t.diagnostic(`preserved failed fixture: ${sandbox}`);
  }
});
