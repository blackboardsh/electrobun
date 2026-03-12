import DB, { type SchemaToDocumentTypes } from "../../../goldfishdb/src/node/index.ts";

export type WindowTabId =
  | "workspace"
  | "projects"
  | "layout"
  | "instances"
  | "cloud"
  | "browser"
  | "terminal"
  | "agent"
  | "windows"
  | "notes"
  | "session";

export type LayoutWindow = {
  id: string;
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

const layoutWindowSchema = object(
  {
    id: string({ required: true, internal: false }),
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
      windows: array(layoutWindowSchema, { required: true, internal: false }),
    }),
    sessionSnapshots: collection({
      key: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
      currentLayoutId: string({ required: true, internal: false }),
      currentWindowId: string({ required: true, internal: false }),
      windows: array(layoutWindowSchema, { required: true, internal: false }),
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

export type DashDocumentTypes = SchemaToDocumentTypes<typeof dashSchema1>;
export type DashDb = ReturnType<typeof createDashDb>;

const LEGACY_WORKSPACE_KEYS = ["marketing", "platform", "client-alpha"] as const;
const LEGACY_PROJECT_KEYS = [
  "campaign-site",
  "brand-copy",
  "launch-assets",
  "electrobun",
  "bunny-cloud",
  "colab-cloud-ref",
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

export const seededLayouts: Array<{
  key: string;
  name: string;
  description: string;
  windows: LayoutWindow[];
}> = [
  {
    key: "current-session",
    name: "Current Session",
    description: "Local Bunny Dash window layout.",
    windows: [
      {
        id: "main",
        title: "Main",
        workspaceId: "local-workspace",
        mainTabIds: ["workspace"],
        sideTabIds: ["session"],
        currentMainTabId: "workspace",
        currentSideTabId: "session",
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
    return new DB<typeof dashSchema1>().init({
      schemaHistory: [{ v: 1, schema: dashSchema1, migrationSteps: false }],
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

  seededLayouts.forEach((layout, index) => {
    db.collection("layouts").insert({
      ...layout,
      sortOrder: index,
    });
  });

  db.collection("sessionSnapshots").insert({
    key: "last",
    updatedAt: Date.now(),
    currentLayoutId: seededLayouts[0]!.key,
    currentWindowId: seededLayouts[0]!.windows[0]!.id,
    windows: structuredClone(seededLayouts[0]!.windows),
  });

  db.collection("uiSettings").insert({
    key: "primary",
    sidebarCollapsed: false,
    bunnyPopoverOpen: false,
    currentLayoutId: seededLayouts[0]!.key,
    currentWindowId: seededLayouts[0]!.windows[0]!.id,
    activeTreeNodeId: `workspace-overview:${seededWorkspaces[0]!.key}`,
  });
}
