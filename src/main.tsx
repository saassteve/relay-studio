import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { OfflineStatus } from "./OfflineStatus";
import "./styles.css";
import "./studio.css";
import "./ui.css";
if (import.meta.env.PROD && "serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
// A rendering error shows a way back instead of a blank window.
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="loading-page">
        <h2>Something went wrong.</h2>
        <p>Your recordings are safe. Reload to pick up where you left off.</p>
        <button className="btn primary" onClick={() => location.reload()}>
          Reload Relay
        </button>
      </div>
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <App />
    <OfflineStatus />
  </Boundary>,
);
