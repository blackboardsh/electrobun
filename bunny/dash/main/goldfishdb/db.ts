export type CurrentDocumentTypes = {
  projects: {
    id: string;
    name: string;
    path: string;
  };
  workspaces: {
    id: string;
    name: string;
    color: string;
    projectIds: string[];
    windows: Array<{
      id: string;
      ui: {
        showSidebar: boolean;
        sidebarWidth: number;
      };
      position: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      expansions: string[];
      rootPane: unknown;
      currentPaneId: string;
      tabs: Record<string, unknown>;
    }>;
  };
};
