import "@mainview/styles/index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@mainview/app";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
