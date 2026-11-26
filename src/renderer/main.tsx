import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/ide.css";
import { App } from "./App.js";

declare global {
  interface Window {
    ide2: import("../shared/protocol.js").Ide2Bridge;
  }
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root container");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
