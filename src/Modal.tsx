import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { MoreHorizontal, X } from "lucide-react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
let open = 0;

// Keeps keyboard focus inside a dialog, closes it on Escape and returns focus to
// whatever opened it. The rest of the page is inert while a dialog is up.
export function useDialog(
  ref: React.RefObject<HTMLElement | null>,
  onClose?: () => void,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    open += 1;
    if (root && !root.contains(node)) root.inert = true;
    const focusables = () =>
      [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
    // Start on the first real control, not the close button.
    const first =
      node.querySelector<HTMLElement>("[autofocus]") ||
      focusables().find((el) => !el.classList.contains("dialog-close")) ||
      node;
    if (!node.contains(document.activeElement))
      first.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && close.current) {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return e.preventDefault();
      const start = items[0],
        end = items[items.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === start ||
          !node.contains(document.activeElement))
      ) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && document.activeElement === end) {
        e.preventDefault();
        start.focus();
      }
    };
    node.addEventListener("keydown", key);
    return () => {
      node.removeEventListener("keydown", key);
      open -= 1;
      if (root && open === 0) root.inert = false;
      // If what opened this has gone (a menu item whose menu closed), go to its menu button.
      const back =
        opener?.isConnected && opener.offsetParent !== null
          ? opener
          : opener?.closest("details")?.querySelector<HTMLElement>("summary");
      back?.focus({ preventScroll: true });
    };
  }, [ref]);
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
}: {
  // Id of the text that says what this dialog is asking.
  describedBy?: string;
  // True for questions that need an answer before anything else.
  alert?: boolean;
  label: string;
  onClose?: () => void;
  className?: string;
  children: ReactNode;
  closeButton?: boolean;
  dismissOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLElement>(null),
    pressed = useRef(false);
  useDialog(ref, onClose);
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
    // A group with nothing chosen yet is still reachable: its first option takes Tab.
    ref: (el: HTMLElement | null) => {
      const group = el?.closest('[role="radiogroup"]');
      if (
        el &&
        group &&
        !group.querySelector('[role="radio"][aria-checked="true"]') &&
        group.querySelector('[role="radio"]') === el
      )
        el.tabIndex = 0;
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
// click elsewhere or press Escape, and hands focus back to its button.
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
    <details className={`more-menu ${className}`} ref={ref}>
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
