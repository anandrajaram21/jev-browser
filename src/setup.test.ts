import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, renderConfig, skillTargets } from "./setup.ts";

test("parseEnv reads KEY=value lines and strips quotes", () => {
  expect(parseEnv(`# comment\nA=1\n  B = "two words" \nC='x'\nlower=no\nEMPTY=\n`)).toEqual({ A: "1", B: "two words", C: "x", EMPTY: "" });
});

test("renderConfig fills template keys, keeps comments and appends unknown keys", () => {
  const template = "# keys\nTYPESAFE_API_KEY=\nTYPESAFE_MODEL=jev-latest\n";
  const out = renderConfig(template, { TYPESAFE_API_KEY: "ts-123", TYPESAFE_MODEL: "jev-latest", AGENT_BROWSER_HEADED: "1" });
  expect(out).toBe("# keys\nTYPESAFE_API_KEY=ts-123\nTYPESAFE_MODEL=jev-latest\n\nAGENT_BROWSER_HEADED=1\n");
  expect(parseEnv(out)).toEqual({ TYPESAFE_API_KEY: "ts-123", TYPESAFE_MODEL: "jev-latest", AGENT_BROWSER_HEADED: "1" });
});

test("skillTargets picks the agent homes that exist, else ~/.agents", () => {
  const home = mkdtempSync(join(tmpdir(), "jev-home-"));
  expect(skillTargets([], home).map((t) => t.dir)).toEqual([join(home, ".agents", "skills", "jev-browser")]);
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  expect(skillTargets([], home).map((t) => t.dir)).toEqual([
    join(home, ".claude", "skills", "jev-browser"),
    join(home, ".codex", "skills", "jev-browser"),
  ]);
  expect(skillTargets(["/x/skills"], home).map((t) => t.dir)).toEqual(["/x/skills/jev-browser"]);
});
