import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { MoreHorizontal, X } from "lucide-react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
// Open dialogs, oldest first. Only the last one answers the keyboard.
const dialogs: HTMLElement[] = [];

// Keeps keyboard focus inside a dialog, closes it on Escape and returns focus to
// whatever opened it. The app behind is inert while a dialog is up. Dialogs can
// stack (a question asked from inside another dialog): the top one has the keyboard.
export function useDialog(
  ref: React.RefObject<HTMLElement | null>,
  onClose?: () => void,
  // What to return focus to, when the caller knows better than "what has focus now".
  from?: HTMLElement | null,
) {
  const close = useRef(onClose);
  close.current = onClose;
  // Read on the first render: by the time effects run, a control inside the
  // dialog that asks for focus has already taken it.
  const [opener] = useState(
    () => from ?? (document.activeElement as HTMLElement | null),
  );
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const root = document.getElementById("root");
    dialogs.push(node);
    if (root && !root.contains(node)) root.inert = true;
    const focusables = () =>
      [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    // Unless a control inside already took focus, start on the first real
    // control, not the close button.
    if (!node.contains(document.activeElement))
      (
        focusables().find((el) => !el.classList.contains("dialog-close")) ||
        node
      ).focus({ preventScroll: true });
    // Heard on the document, so the keys still work when focus has ended up
    // outside the dialog (on the page, or in a dialog underneath).
    const key = (e: KeyboardEvent) => {
      if (dialogs[dialogs.length - 1] !== node) return;
      if (e.key === "Escape" && close.current) {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return e.preventDefault();
      const start = items[0],
        end = items[items.length - 1],
        active = document.activeElement,
        outside = !node.contains(active);
      // The dialog itself can hold focus; Shift+Tab from there must not leave it.
      if (e.shiftKey && (active === start || active === node || outside)) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && (active === end || outside)) {
        e.preventDefault();
        start.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      dialogs.splice(dialogs.indexOf(node), 1);
      if (root && !dialogs.some((d) => !root.contains(d))) root.inert = false;
      // If what opened this has gone (a menu item whose menu closed), go to its menu button.
      const back =
        opener?.isConnected && opener.offsetParent !== null
          ? opener
          : opener?.closest("details")?.querySelector<HTMLElement>("summary");
      back?.focus({ preventScroll: true });
    };
  }, [ref, opener]);
}

export function Modal({
  label,
  onClose,
  className = "",
  children,
  closeButton = true,
  dismissOnBackdrop = true,
  describedBy,
  alert = false,
  opener,
}: {
  // Id of the text that says what this dialog is asking.
  describedBy?: string;
  // True for questions that need an answer before anything else.
  alert?: boolean;
  // Where focus goes when this closes. Defaults to what had focus when it opened.
  opener?: HTMLElement | null;
  label: string;
  onClose?: () => void;
  className?: string;
  children: ReactNode;
  closeButton?: boolean;
  dismissOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLElement>(null),
    pressed = useRef(false);
  useDialog(ref, onClose, opener);
  return createPortal(
    <div
      className="dialog-backdrop"
      // Only a full click on the backdrop closes it: a press that started inside
      // the dialog (selecting text, dragging a slider) never does.
      onMouseDown={(e) => {
        pressed.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (
          dismissOnBackdrop &&
          onClose &&
          pressed.current &&
          e.target === e.currentTarget
        )
          onClose();
        pressed.current = false;
      }}
    >
      <section
        ref={ref}
        className={`dialog ${className}`}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={label}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {closeButton && onClose && (
          <button
            className="dialog-close icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        )}
        <div className="dialog-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

// A yes/no question in the app's own style. Resolves true when confirmed.
export function confirmDialog({
  title,
  body,
  confirm,
  cancel = "Cancel",
  destructive = false,
}: {
  title: string;
  body?: string;
  confirm: string;
  cancel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  // Noted now: this renders a moment later, and focus may have moved by then.
  const opener = document.activeElement as HTMLElement | null;
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const done = (value: boolean) => {
      root.unmount();
      host.remove();
      resolve(value);
    };
    root.render(
      <Modal
        label={title}
        className="small-dialog"
        onClose={() => done(false)}
        closeButton={false}
        alert
        opener={opener}
        describedBy={body ? "confirm-body" : undefined}
      >
        <h2>{title}</h2>
        {body && (
          <p className="muted" id="confirm-body">
            {body}
          </p>
        )}
        <div className="dialog-footer">
          <button
            className="btn"
            autoFocus={destructive}
            onClick={() => done(false)}
          >
            {cancel}
          </button>
          <button
            className={`btn ${destructive ? "destructive" : "primary"}`}
            autoFocus={!destructive}
            onClick={() => done(true)}
          >
            {confirm}
          </button>
        </div>
      </Modal>,
    );
  });
}

// Arrow-key behaviour for groups of custom radio buttons.
export function radio(checked: boolean) {
  return {
    role: "radio" as const,
    "aria-checked": checked,
    tabIndex: checked ? 0 : -1,
    // Exactly one option in a group takes Tab: the chosen one, or the first that
    // can be used while nothing is chosen. Worked out for the whole group after
    // every render, so a stop handed to the first option is taken back later.
    ref: (el: HTMLElement | null) => {
      const group = el?.closest('[role="radiogroup"]');
      if (!group) return;
      const items = [
        ...group.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      ];
      const stop =
        items.find((item) => item.getAttribute("aria-checked") === "true") ||
        items.find((item) => !item.disabled);
      for (const item of items) item.tabIndex = item === stop ? 0 : -1;
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      const step =
        e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? -1
            : 0;
      if (!step) return;
      const group = e.currentTarget.closest('[role="radiogroup"]');
      if (!group) return;
      const items = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
      const next =
        items[
          (items.indexOf(e.currentTarget) + step + items.length) % items.length
        ];
      e.preventDefault();
      next.focus();
      next.click();
    },
  };
}

// A small pop-up menu behind a "more" button. It closes when you pick something,
// click or Tab elsewhere, or press Escape (which hands focus back to its button).
export function Menu({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: Event) => {
      const menu = ref.current;
      if (menu?.open && !menu.contains(e.target as Node)) menu.open = false;
    };
    const key = (e: KeyboardEvent) => {
      const menu = ref.current;
      if (e.key !== "Escape" || !menu?.open) return;
      e.stopPropagation();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, []);
  return (
    <details
      className={`more-menu ${className}`}
      ref={ref}
      // Tabbing out of the menu closes it, so it is never left open behind you.
      onBlur={(e) => {
        const menu = ref.current;
        if (menu?.open && e.relatedTarget && !menu.contains(e.relatedTarget))
          menu.open = false;
      }}
    >
      <summary className="icon-button" aria-label={label}>
        <MoreHorizontal size={18} />
      </summary>
      <div
        className="more-panel"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("[data-close]") && ref.current)
            ref.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}

// ARIA and arrow-key behaviour for one tab; pair with tabPanel() on its content.
export function tab(selected: boolean, id: string) {
  return {
    role: "tab" as const,
    id: `tab-${id}`,
    "aria-selected": selected,
    "aria-controls": `panel-${id}`,
    tabIndex: selected ? 0 : -1,
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      const all = [
        ...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
          '[role="tab"]',
        ) || []),
      ];
      const at = all.indexOf(e.currentTarget);
      const next =
        e.key === "Home"
          ? all[0]
          : e.key === "End"
            ? all[all.length - 1]
            : e.key === "ArrowRight"
              ? all[(at + 1) % all.length]
              : e.key === "ArrowLeft"
                ? all[(at - 1 + all.length) % all.length]
                : null;
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      next.focus();
      next.click();
    },
  };
}
export const tabPanel = (id: string) => ({
  role: "tabpanel" as const,
  id: `panel-${id}`,
  "aria-labelledby": `tab-${id}`,
});
