import DB, { type SchemaToDocumentTypes } from "../../../goldfishdb/src/node/index.ts";

export type WindowTabId =
  | "workspace"
  | "projects"
  | "lens"
  | "instances"
  | "cloud"
  | "browser"
  | "terminal"
  | "agent"
  | "windows"
  | "notes"
  | "current-state";

export type LensWindow = {
  id: string;
  lensId?: string;
  title: string;
  workspaceId: string;
  mainTabIds: WindowTabId[];
  sideTabIds: WindowTabId[];
  currentMainTabId: WindowTabId;
  currentSideTabId: WindowTabId;
};

const {
  array,
  boolean,
  collection,
  defaultOpts,
  number,
  object,
  schema,
  string,
} = DB.v1.schemaType;

const lensWindowSchema = object(
  {
    id: string({ required: true, internal: false }),
    lensId: string({ required: false, internal: false }),
    title: string({ required: true, internal: false }),
    workspaceId: string({ required: true, internal: false }),
    mainTabIds: array(string(defaultOpts), { required: true, internal: false }),
    sideTabIds: array(string(defaultOpts), { required: true, internal: false }),
    currentMainTabId: string({ required: true, internal: false }),
    currentSideTabId: string({ required: true, internal: false }),
  },
  { required: true, internal: false },
);

export const dashSchema1 = schema({
  v: 1,
  stores: {
    workspaces: collection({
      key: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      subtitle: string({ required: true, internal: false }),
      sortOrder: number({ required: true, internal: false }),
    }),
    projectMounts: collection({
      key: string({ required: true, internal: false }),
      workspaceId: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      instanceId: string({ required: true, internal: false }),
      instanceLabel: string({ required: true, internal: false }),
      path: string({ required: true, internal: false }),
      kind: string({ required: true, internal: false }),
      status: string({ required: true, internal: false }),
      sortOrder: number({ required: true, internal: false }),
    }),
    layouts: collection({
      key: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      description: string({ required: true, internal: false }),
      sortOrder: number({ required: true, internal: false }),
      windows: array(lensWindowSchema, { required: true, internal: false }),
    }),
    sessionSnapshots: collection({
      key: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
      currentLayoutId: string({ required: true, internal: false }),
      currentWindowId: string({ required: true, internal: false }),
      windows: array(lensWindowSchema, { required: true, internal: false }),
    }),
    uiSettings: collection({
      key: string({ required: true, internal: false }),
      sidebarCollapsed: boolean({ required: true, internal: false }),
      bunnyPopoverOpen: boolean({ required: true, internal: false }),
      currentLayoutId: string({ required: true, internal: false }),
      currentWindowId: string({ required: true, internal: false }),
      activeTreeNodeId: string({ required: true, internal: false }),
    }),
  },
});

export const dashSchema2 = schema({
  v: 2,
  stores: {
    workspaces: collection({
      key: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      subtitle: string({ required: true, internal: false }),
      sortOrder: number({ required: true, internal: false }),
    }),
    projectMounts: collection({
      key: string({ required: true, internal: false }),
      workspaceId: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      instanceId: string({ required: true, internal: false }),
      instanceLabel: string({ required: true, internal: false }),
      path: string({ required: true, internal: false }),
      kind: string({ required: true, internal: false }),
      status: string({ required: true, internal: false }),
      sortOrder: number({ required: true, internal: false }),
    }),
    layouts: collection({
      key: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      description: string({ required: true, internal: false }),
      workspaceId: string({ required: false, internal: false }),
      windowStateJson: string({ required: false, internal: false }),
      sortOrder: number({ required: true, internal: false }),
      windows: array(lensWindowSchema, { required: true, internal: false }),
    }),
    sessionSnapshots: collection({
      key: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
      currentLayoutId: string({ required: true, internal: false }),
      currentWindowId: string({ required: true, internal: false }),
      windows: array(lensWindowSchema, { required: true, internal: false }),
    }),
    uiSettings: collection({
      key: string({ required: true, internal: false }),
      sidebarCollapsed: boolean({ required: true, internal: false }),
      bunnyPopoverOpen: boolean({ required: true, internal: false }),
      currentLayoutId: string({ required: true, internal: false }),
      currentWindowId: string({ required: true, internal: false }),
      activeTreeNodeId: string({ required: true, internal: false }),
    }),
  },
});

export type DashDocumentTypes = SchemaToDocumentTypes<typeof dashSchema2>;
export type DashDb = ReturnType<typeof createDashDb>;

const LEGACY_WORKSPACE_KEYS = ["marketing", "platform", "client-alpha"] as const;
const LEGACY_PROJECT_KEYS = [
  "campaign-site",
  "brand-copy",
  "launch-assets",
  "electrobun",
  "bunny-cloud",
  "bunny-cloud-ref",
  "alpha-portal",
  "alpha-deploy",
] as const;
const LEGACY_LAYOUT_KEYS = ["marketing-day", "fleet-ops"] as const;

export const seededWorkspaces = [
  {
    key: "local-workspace",
    name: "Local Workspace",
    subtitle: "Project folders on this Bunny Ears instance.",
  },
] as const;

export const seededProjectMounts: Array<{
  key: string;
  workspaceId: string;
  name: string;
  instanceId: string;
  instanceLabel: string;
  path: string;
  kind: string;
  status: string;
}> = [];

export const seededLenses: Array<{
  key: string;
  name: string;
  description: string;
  workspaceId: string;
  windowStateJson: string;
  windows: LensWindow[];
}> = [
  {
    key: "starter-lens",
    name: "Starter Lens",
    description: "Default Bunny Dash lens for local work.",
    workspaceId: "local-workspace",
    windowStateJson: JSON.stringify({
      id: "main",
      ui: {
        showSidebar: true,
        sidebarWidth: 250,
      },
      position: {
        x: 0,
        y: 0,
        width: 1500,
        height: 900,
      },
      expansions: [],
      rootPane: {
        id: "root",
        type: "pane",
        tabIds: [],
        currentTabId: null,
      },
      tabs: {},
      currentPaneId: "root",
    }),
    windows: [
      {
        id: "main",
        title: "Main",
        workspaceId: "local-workspace",
        mainTabIds: ["workspace"],
        sideTabIds: ["current-state"],
        currentMainTabId: "workspace",
        currentSideTabId: "current-state",
      },
    ],
  },
];

function resetCollection(db: DashDb, collectionName: "workspaces" | "projectMounts" | "layouts" | "sessionSnapshots" | "uiSettings") {
  const documents = db.collection(collectionName).query().data || [];
  for (const document of documents) {
    db.collection(collectionName).remove(document.id);
  }
}

function hasExactKeys(actual: string[], expected: readonly string[]) {
  if (actual.length !== expected.length) {
    return false;
  }
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.every((value, index) => value === expectedSorted[index]);
}

export function migrateLegacyExampleData(db: DashDb) {
  const workspaces = db.collection("workspaces").query().data || [];
  const projectMounts = db.collection("projectMounts").query().data || [];
  const layouts = db.collection("layouts").query().data || [];

  const matchesLegacyExamples =
    hasExactKeys(
      workspaces.map((workspace) => workspace.key),
      LEGACY_WORKSPACE_KEYS,
    ) &&
    hasExactKeys(
      projectMounts.map((project) => project.key),
      LEGACY_PROJECT_KEYS,
    ) &&
    hasExactKeys(
      layouts.map((layout) => layout.key),
      LEGACY_LAYOUT_KEYS,
    );

  if (!matchesLegacyExamples) {
    return;
  }

  resetCollection(db, "projectMounts");
  resetCollection(db, "layouts");
  resetCollection(db, "workspaces");
  resetCollection(db, "sessionSnapshots");
  resetCollection(db, "uiSettings");

  seedDashDb(db);
}

export function createDashDb(dbFolder: string) {
  const originalConsoleError = console.error;

  console.error = (...args: unknown[]) => {
    if (args[0] === "failed to parse on load") {
      return;
    }
    originalConsoleError(...args);
  };

  try {
    return new DB<typeof dashSchema2>().init({
      schemaHistory: [
        { v: 1, schema: dashSchema1, migrationSteps: false },
        { v: 2, schema: dashSchema2, migrationSteps: false },
      ],
      db_folder: dbFolder,
    });
  } finally {
    console.error = originalConsoleError;
  }
}

export function seedDashDb(db: DashDb) {
  const existingWorkspaces = db.collection("workspaces").query().data || [];
  if (existingWorkspaces.length > 0) {
    return;
  }

  seededWorkspaces.forEach((workspace, index) => {
    db.collection("workspaces").insert({
      ...workspace,
      sortOrder: index,
    });
  });

  seededProjectMounts.forEach((projectMount, index) => {
    db.collection("projectMounts").insert({
      ...projectMount,
      sortOrder: index,
    });
  });

  seededLenses.forEach((lens, index) => {
    db.collection("layouts").insert({
      ...lens,
      sortOrder: index,
    });
  });

  db.collection("sessionSnapshots").insert({
    key: "last",
    updatedAt: Date.now(),
    currentLayoutId: seededLenses[0]!.key,
    currentWindowId: seededLenses[0]!.windows[0]!.id,
    windows: structuredClone(seededLenses[0]!.windows),
  });

  db.collection("uiSettings").insert({
    key: "primary",
    sidebarCollapsed: false,
    bunnyPopoverOpen: false,
    currentLayoutId: seededLenses[0]!.key,
    currentWindowId: seededLenses[0]!.windows[0]!.id,
    activeTreeNodeId: `lens-overview:${seededLenses[0]!.key}`,
  });
}
