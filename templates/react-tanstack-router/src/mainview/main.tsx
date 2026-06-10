import "@/index.css";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import {
  RouterProvider,
  createHashHistory,
  createRouter,
} from "@tanstack/react-router";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Create a hash history instance
// More info: https://tanstack.com/router/latest/docs/guide/history-types#hash-routing
const hashHistory = createHashHistory();

// Create a new router instance
const router = createRouter({
  routeTree,
  history: hashHistory,
  defaultPreload: "intent",
  defaultPendingMs: 0,
  defaultPendingComponent: () => <div className="p-2">Loading...</div>,
  defaultErrorComponent: () => <div className="p-2">Error!</div>,
});

// Register the router instance for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Render the app
const rootElement = document.getElementById("root")!;
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
