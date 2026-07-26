import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installBrowserFallback } from "./services/browserFallback";
import { installWebViewBridge } from "./services/webviewBridge";
import "./styles.css";

installWebViewBridge();
installBrowserFallback();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
