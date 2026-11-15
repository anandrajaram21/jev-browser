// Turns a page snapshot into a flat list of complete, executable moves.
// Jev answers each question in isolation, so it picks one whole move
// ("type email into 'E-mail address'") rather than a verb and a target separately.

import type { PageElement } from "./browser.ts";

export type Move =
  | { kind: "cmd"; id: string; desc: string; args: string[]; navigates?: boolean }
  | { kind: "write"; id: string; desc: string; ref: string; field: string } // text composed on demand by the text model
  | { kind: "finish"; id: string; desc: string };

const CLICKABLE = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "treeitem", "gridcell", "cell", "row", "slider",
]);
const TYPEABLE = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function label(el: PageElement): string {
  const state: string[] = [];
  if (el.attrs.checked !== undefined) state.push(el.attrs.checked === "true" ? "checked" : "unchecked");
  if (el.attrs.selected) state.push("selected");
  if (el.attrs.disabled) state.push("disabled");
  if (el.value) state.push(`current value "${clip(el.value, 40)}"`);
  return `${el.role} "${clip(el.name || "(unnamed)")}"${state.length ? ` (${state.join(", ")})` : ""}`;
}

export function buildMoves(elements: PageElement[], inputs: Record<string, string>, canWrite: boolean): Move[] {
  const moves: Move[] = [];
  const byRef = new Map(elements.map((e) => [e.ref, e]));
  const isSelect = (el: PageElement) => el.role === "combobox" && elements.some((o) => o.parent === el.ref && o.role === "option");

  for (const el of elements) {
    if (el.attrs.disabled) continue;
    const parent = el.parent ? byRef.get(el.parent) : undefined;

    if (el.role === "option" && parent && isSelect(parent)) {
      if (el.attrs.selected) continue;
      moves.push({
        kind: "cmd", id: `${el.ref}:select`, desc: `choose "${clip(el.name)}" in ${label(parent)}`,
        args: ["select", `@${parent.ref}`, el.name],
      });
      continue;
    }
    if (isSelect(el)) continue; // its options are the moves

    if (TYPEABLE.has(el.role)) {
      for (const [key, value] of Object.entries(inputs)) {
        if (el.value === value) continue;
        moves.push({
          kind: "cmd", id: `${el.ref}:fill:${key}`, desc: `type ${key} ("${clip(value, 40)}") into ${label(el)}`,
          args: ["fill", `@${el.ref}`, value],
        });
      }
      if (canWrite) moves.push({ kind: "write", id: `${el.ref}:write`, desc: `write new text into ${label(el)}`, ref: el.ref, field: label(el) });
      if (el.role === "combobox") moves.push({ kind: "cmd", id: `${el.ref}:click`, desc: `open ${label(el)}`, args: ["click", `@${el.ref}`] });
      continue;
    }

    if (CLICKABLE.has(el.role)) {
      moves.push({
        kind: "cmd", id: `${el.ref}:click`, desc: `click ${label(el)}`, args: ["click", `@${el.ref}`],
        navigates: el.role === "link" || el.role === "button",
      });
    }
  }

  moves.push(
    { kind: "finish", id: "finish", desc: "finish: the goal is already achieved, no more actions needed" },
    { kind: "cmd", id: "key:enter", desc: "press Enter (submit the focused field)", args: ["press", "Enter"], navigates: true },
    { kind: "cmd", id: "scroll:down", desc: "scroll down to reveal more of the page", args: ["scroll", "down", "700"] },
    { kind: "cmd", id: "scroll:up", desc: "scroll up", args: ["scroll", "up", "700"] },
    { kind: "cmd", id: "nav:back", desc: "go back to the previous page", args: ["back"], navigates: true },
    { kind: "cmd", id: "nav:reload", desc: "reload the current page", args: ["reload"], navigates: true },
  );
  return moves;
}
