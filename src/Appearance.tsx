import { useState } from "react";
import { SunMoon } from "lucide-react";
import { radio } from "./Modal";

// Light, dark, or whatever the computer is set to. This is a convenience of
// one device, so it is kept in the browser rather than with the library. The
// page reads it again in index.html, before anything is drawn.
type Theme = "system" | "light" | "dark";
const KEY = "relay-theme";
const OPTIONS: [Theme, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

// What the page is showing now. The attribute is the one source of truth, so
// this is right even where the browser refuses to store anything.
function current(): Theme {
  const value = document.documentElement.getAttribute("data-theme");
  return value === "light" || value === "dark" ? value : "system";
}

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be blocked. The choice then lasts until the page is closed.
  }
  // The Mac app's window, menus and dialogs follow, now and when it next opens.
  void window.relayDesktop?.setTheme?.(theme);
}

export function AppearanceSetting() {
  const [theme, setTheme] = useState<Theme>(current);
  return (
    <>
      <h3 className="studio-section-title">
        <SunMoon size={17} />
        Appearance
      </h3>
      <div className="appearance-setting">
        <div className="choice" role="radiogroup" aria-label="Appearance">
          {OPTIONS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              {...radio(theme === value)}
              className={theme === value ? "selected" : undefined}
              onClick={() => {
                apply(value);
                setTheme(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="studio-hint">
          System follows your computer’s light or dark setting. Your choice is
          saved on this device.
        </p>
      </div>
    </>
  );
}
