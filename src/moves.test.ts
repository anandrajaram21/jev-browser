import { expect, test } from "bun:test";
import { parseSnapshot } from "./browser.ts";
import { buildMoves } from "./moves.ts";

const SNAPSHOT = `- heading "Order" [level=1, ref=e1]
- textbox "Customer name:" [ref=e2]
- textbox "E-mail address:" [ref=e3]: ada@example.com
- radio "Large" [checked=false, ref=e4]
- checkbox "Bacon" [checked=true, ref=e5]
- combobox "Size" [expanded=false, ref=e6]: S
  - option "S" [selected, ref=e7]
  - option "M" [ref=e8]
- button "Submit \\"now\\"" [disabled, ref=e9]
- StaticText "Some text"
- link "Home" [ref=e10]`;

test("parseSnapshot reads refs, attrs, values and parents", () => {
  const els = parseSnapshot(SNAPSHOT);
  expect(els.map((e) => e.ref)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10"]);
  const byRef = Object.fromEntries(els.map((e) => [e.ref, e]));
  expect(byRef.e3!.value).toBe("ada@example.com");
  expect(byRef.e5!.attrs.checked).toBe("true");
  expect(byRef.e7!.attrs.selected).toBe(true);
  expect(byRef.e8!.parent).toBe("e6");
  expect(byRef.e10!.parent).toBeUndefined();
  expect(byRef.e9!.name).toBe('Submit "now"');
});

test("buildMoves turns elements into complete moves", () => {
  const moves = buildMoves(parseSnapshot(SNAPSHOT), { name: "Ada Lovelace", email: "ada@example.com" }, true);
  const ids = moves.map((m) => m.id);

  expect(ids).toContain("e2:fill:name");
  expect(ids).toContain("e2:write");
  expect(ids).not.toContain("e3:fill:email"); // already holds that value
  expect(ids).toContain("e4:click");
  expect(ids).toContain("e8:select");
  expect(ids).not.toContain("e7:select"); // already selected
  expect(ids).not.toContain("e6:click"); // a native select is driven through its options
  expect(ids).not.toContain("e9:click"); // disabled
  expect(ids).not.toContain("e1:click"); // headings aren't actionable
  expect(ids).toContain("finish");

  const select = moves.find((m) => m.id === "e8:select")!;
  expect(select.kind === "cmd" && select.args).toEqual(["select", "@e6", "M"]);
});

test("buildMoves omits free-text moves without a text model", () => {
  const ids = buildMoves(parseSnapshot(SNAPSHOT), {}, false).map((m) => m.id);
  expect(ids.some((id) => id.endsWith(":write"))).toBe(false);
});
