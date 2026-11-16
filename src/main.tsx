import { createRoot } from "react-dom/client";
import App from "./App";
import { OfflineStatus } from "./OfflineStatus";
import "./styles.css";
import "./studio.css";
if (import.meta.env.PROD && "serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <OfflineStatus />
  </>,
);
