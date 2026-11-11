const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const version = required("ELECTROBUN_UPDATER_E2E_VERSION");
const managedAppId = process.env.ELECTROBUN_UPDATER_E2E_MANAGED_APP_ID;
const managedApiUrl = process.env.ELECTROBUN_UPDATER_E2E_MANAGED_API_URL;
const insightsEnabled = process.env.ELECTROBUN_UPDATER_E2E_INSIGHTS === "1";
if (Boolean(managedAppId) !== Boolean(managedApiUrl) || (insightsEnabled && !managedAppId)) {
  throw new Error("Managed lifecycle requires both an app ID and an explicit test API URL");
}
if (!["1.0.0", "2.0.0", "3.0.0", "4.0.0"].includes(version)) {
  throw new Error(`unsupported updater lifecycle fixture version: ${version}`);
}

export default {
  app: {
    name: required("ELECTROBUN_UPDATER_E2E_NAME"),
    identifier: required("ELECTROBUN_UPDATER_E2E_IDENTIFIER"),
    version,
    description: "Native updater lifecycle test fixture",
  },
  runtime: { exitOnLastWindowClosed: false },
  build: {
    mainProcess: "zig",
    zig: { version: "0.17.0" },
    buildFolder: "build",
    artifactFolder: "artifacts",
    copy: {
      "src/control.json": "updater-lifecycle-control.json",
      "src/release-marker.txt": "updater-lifecycle-release-marker.txt",
    },
    mac: { bundleCEF: false, bundleWGPU: false, codesign: false, notarize: false, createDmg: true },
    linux: { bundleCEF: false, bundleWGPU: false },
    win: { bundleCEF: false, bundleWGPU: false },
  },
  release: {
    ...(managedAppId
      ? { managed: { appId: managedAppId, apiUrl: managedApiUrl } }
      : { baseUrl: required("ELECTROBUN_UPDATER_E2E_BASE_URL") }),
    generatePatch: true,
  },
  ...(insightsEnabled ? { insights: { appId: managedAppId, apiUrl: managedApiUrl, enabled: true } } : {}),
};
