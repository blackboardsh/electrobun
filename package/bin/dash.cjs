#!/usr/bin/env node

const { execFileSync, spawn } = require("node:child_process");
const {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  unlinkSync,
} = require("node:fs");
const { dirname, join } = require("node:path");
const https = require("node:https");
const { ProxyAgent } = require("proxy-agent");

const platformNames = { darwin: "darwin", linux: "linux", win32: "win" };
const archNames = { arm64: "arm64", x64: "x64" };
const platform = platformNames[process.platform];
const arch = process.platform === "win32" ? "x64" : archNames[process.arch];

if (!platform || !arch) {
  console.error(`dash: unsupported platform ${process.platform}-${process.arch}`);
  process.exit(1);
}

const extension = platform === "win" ? ".exe" : "";
const packageRoot = join(__dirname, "..");
const cacheRoot = join(packageRoot, ".cache", `${platform}-${arch}`);
const names = [`dash${extension}`, `cottontail${extension}`];
const packagePaths = names.map((name) => join(__dirname, name));
const cachePaths = names.map((name) => join(cacheRoot, name));

function download(url, destination) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(destination), { recursive: true });
    const request = https.get(url, { agent: new ProxyAgent() }, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        response.resume();
        download(new URL(response.headers.location, url), destination)
          .then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`download returned HTTP ${response.statusCode}`));
        return;
      }
      const output = createWriteStream(destination);
      response.pipe(output);
      output.on("finish", () => output.close(resolve));
      output.on("error", reject);
    });
    request.on("error", reject);
  });
}

function installFromCache() {
  mkdirSync(__dirname, { recursive: true });
  for (let index = 0; index < names.length; index += 1) {
    copyFileSync(cachePaths[index], packagePaths[index]);
    if (platform !== "win") chmodSync(packagePaths[index], 0o755);
  }
}

async function ensureRuntime() {
  if (packagePaths.every(existsSync)) return packagePaths[0];
  if (cachePaths.every(existsSync)) {
    installFromCache();
    return packagePaths[0];
  }

  const { version } = require(join(packageRoot, "package.json"));
  const archive = join(cacheRoot, `electrobun-cli-${platform}-${arch}.tar.gz`);
  const url = `https://github.com/blackboardsh/electrobun/releases/download/v${version}/electrobun-cli-${platform}-${arch}.tar.gz`;
  console.log(`Downloading Dash ${version} for ${platform}-${arch}...`);
  await download(url, archive);
  mkdirSync(cacheRoot, { recursive: true });
  const tar = platform === "win"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  execFileSync(tar, ["-xzf", archive, "-C", cacheRoot], { stdio: "pipe" });
  unlinkSync(archive);
  if (!cachePaths.every(existsSync)) {
    throw new Error("the Electrobun CLI archive did not contain Dash and Cottontail");
  }
  installFromCache();
  return packagePaths[0];
}

ensureRuntime()
  .then((dash) => {
    const child = spawn(dash, process.argv.slice(2), {
      cwd: process.cwd(),
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(`dash: ${error.message}`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });
  })
  .catch((error) => {
    console.error(`dash: ${error.message}`);
    process.exit(1);
  });
