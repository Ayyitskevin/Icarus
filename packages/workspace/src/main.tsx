import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { bootstrapActionSession } from "./action-session.js";
import "./styles.css";

bootstrapActionSession();

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Icarus workspace root element is missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
