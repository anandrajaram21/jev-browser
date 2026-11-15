// Install-time commands (setup, doctor, install-skill) and config loading.
// The CLI ships as a single compiled binary, so the config template and the
// skill are embedded here instead of being read from a checkout.
import { noul, type TypeSafeClient } from "@typesafe-ai/sdk";
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Browser } from "./browser.ts";
import { TextModel, textModelFromEnv } from "./text.ts";
import envTemplate from "../.env.example" with { type: "text" };
import skill from "../skills/jev-browser/SKILL.md" with { type: "text" };

export const CONFIG_PATH =
  process.env.JEV_BROWSER_CONFIG ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jev-browser", "config");

const KEYS = [
  { name: "TYPESAFE_API_KEY", label: "TypeSafe API key (https://typesafe.ai)" },
  { name: "TEXT_MODEL_API_KEY", label: "OpenRouter API key (https://openrouter.ai)" },
] as const;

// Agents whose skills directory install-skill writes to, when their home exists.
const AGENT_HOMES = [
  { dir: ".claude", agent: "Claude Code" },
  { dir: ".codex", agent: "Codex" },
  { dir: ".cursor", agent: "Cursor" },
  { dir: ".agents", agent: "agents reading ~/.agents" },
];

const DOCTOR_BROWSER_TIMEOUT_MS = 30_000;

/** Parse KEY=value lines (the .env format). Comments and blank lines are skipped. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Fill the template's KEY= lines from `values`, keeping its comments; append keys the template lacks. */
export function renderConfig(template: string, values: Record<string, string>): string {
  const seen = new Set<string>();
  const lines = template.replace(/\n+$/, "").split("\n").map((line) => {
    const m = /^(\s*)([A-Z0-9_]+)\s*=/.exec(line);
    if (!m || !(m[2]! in values)) return line;
    seen.add(m[2]!);
    return `${m[1]}${m[2]}=${values[m[2]!]}`;
  });
  const extra = Object.entries(values).filter(([k]) => !seen.has(k));
  if (extra.length) lines.push("", ...extra.map(([k, v]) => `${k}=${v}`));
  return lines.join("\n").replace(/\n*$/, "\n");
}

async function readEnvFile(path: string): Promise<Record<string, string> | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? parseEnv(await file.text()) : undefined;
}

/**
 * Fill unset env vars from config files. Bun auto-loads ./.env first; then a
 * checkout's own .env (so `bun src/cli.ts` works from any directory), then the
 * user config that `jev-browser setup` writes. Real env vars always win.
 */
export async function loadConfig() {
  for (const path of [join(import.meta.dir, "..", ".env"), CONFIG_PATH]) {
    for (const [k, v] of Object.entries((await readEnvFile(path)) ?? {})) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

/** Read a line from the terminal without echoing it. */
async function readSecret(label: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(label);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on("data", onData);
  });
}

const mask = (key: string) => (key.length > 8 ? `…${key.slice(-4)}` : "set");

/**
 * Write the user config. Interactive on a terminal; otherwise it saves the keys
 * already in the environment, so an agent can run `TYPESAFE_API_KEY=… jev-browser setup`.
 */
export async function setup() {
  const existing = (await readEnvFile(CONFIG_PATH)) ?? {};
  const values = { ...parseEnv(envTemplate), ...existing };
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (interactive) console.log(`jev-browser setup: keys are saved to ${CONFIG_PATH}\nPress Enter to keep the value shown in brackets.\n`);

  for (const { name, label } of KEYS) {
    const current = process.env[name] || values[name] || "";
    const entered = interactive ? await readSecret(`${label}${current ? ` [${mask(current)}]` : ""}: `) : "";
    values[name] = entered || current;
  }
  const missing = KEYS.filter((k) => !values[k.name]).map((k) => k.name);
  if (missing.length && !interactive) {
    throw new Error(`no terminal to prompt on; set ${missing.join(" and ")} in the environment and run setup again`);
  }

  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, renderConfig(envTemplate, values), { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600); // writeFileSync's mode only applies to new files
  console.log(`Saved ${CONFIG_PATH}`);
  for (const { name } of KEYS) console.log(`  ${name} ${values[name] ? mask(values[name]) : "(not set)"}`);
  if (missing.length) console.log(`\n${missing.join(" and ")} still missing; run jev-browser setup again once you have it.`);
  console.log("\nNext: jev-browser doctor");
}

/** Where install-skill writes, given `--dir` overrides or the agent homes that exist. */
export function skillTargets(dirs: string[] = [], home = homedir()): { dir: string; agent: string }[] {
  if (dirs.length) return dirs.map((dir) => ({ dir: join(dir, "jev-browser"), agent: dir }));
  const found = AGENT_HOMES.filter((h) => {
    try {
      return lstatSync(join(home, h.dir)).isDirectory();
    } catch {
      return false;
    }
  });
  return (found.length ? found : AGENT_HOMES.filter((h) => h.dir === ".agents")).map((h) => ({
    dir: join(home, h.dir, "skills", "jev-browser"),
    agent: h.agent,
  }));
}

/** Copy the embedded SKILL.md into each agent's skills directory. */
export async function installSkill(dirs: string[] = []) {
  for (const { dir, agent } of skillTargets(dirs)) {
    // A symlink here usually points at a checkout's skills/ folder; writing
    // through it would overwrite the repo's own file.
    let link: string | undefined;
    try {
      if (lstatSync(dir).isSymbolicLink()) link = readlinkSync(dir);
    } catch {}
    if (link) {
      console.log(`skip ${dir} (symlink to ${link}; already tracks that copy)`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "SKILL.md"), skill);
    console.log(`installed ${join(dir, "SKILL.md")} (${agent})`);
  }
}

interface Check {
  name: string;
  ok: boolean | "warn";
  detail: string;
  fix?: string;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`${what} timed out after ${ms / 1000}s`)))]);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);

async function checkBrowser(): Promise<Check[]> {
  const bin = Bun.which("agent-browser");
  if (!bin) {
    return [{ name: "agent-browser", ok: false, detail: "not found on PATH", fix: "npm i -g agent-browser && agent-browser install   (or: brew install agent-browser)" }];
  }
  const version = Bun.spawnSync(["agent-browser", "--version"]).stdout.toString().trim();
  const checks: Check[] = [{ name: "agent-browser", ok: true, detail: `${version || "unknown version"} (${bin})` }];
  // Launch a real browser in a throwaway session, then close only that session.
  const browser = new Browser(`jev-doctor-${process.pid}`);
  try {
    await withTimeout(browser.run("open", "about:blank"), DOCTOR_BROWSER_TIMEOUT_MS, "browser launch");
    checks.push({ name: "browser", ok: true, detail: "launches" });
  } catch (err) {
    checks.push({ name: "browser", ok: false, detail: message(err), fix: "agent-browser install" });
  } finally {
    await browser.run("close").catch(() => {});
  }
  return checks;
}

async function checkJev(jev: () => TypeSafeClient): Promise<Check> {
  if (!process.env.TYPESAFE_API_KEY) return { name: "TypeSafe key", ok: false, detail: "TYPESAFE_API_KEY is not set", fix: "jev-browser setup" };
  try {
    await jev().systemOne({ state: { note: "jev-browser doctor" }, questions: { ok: noul("This is a connectivity check.") }, model: process.env.TYPESAFE_MODEL ?? "jev-latest" });
    return { name: "TypeSafe key", ok: true, detail: "Jev answered" };
  } catch (err) {
    return { name: "TypeSafe key", ok: false, detail: message(err), fix: "jev-browser setup   (check the key at https://typesafe.ai)" };
  }
}

async function checkText(): Promise<Check> {
  const cfg = textModelFromEnv();
  if (!cfg) return { name: "OpenRouter key", ok: false, detail: "TEXT_MODEL_API_KEY is not set (needed for --report and planning)", fix: "jev-browser setup" };
  try {
    await new TextModel(cfg).ping();
    return { name: "OpenRouter key", ok: true, detail: `${cfg.model} answered` };
  } catch (err) {
    return { name: "OpenRouter key", ok: false, detail: message(err), fix: "jev-browser setup   (check the key and credits at https://openrouter.ai)" };
  }
}

function checkSkill(): Check {
  const installed = AGENT_HOMES.map((h) => join(homedir(), h.dir, "skills", "jev-browser", "SKILL.md")).filter((p) => existsSync(p));
  return installed.length
    ? { name: "agent skill", ok: true, detail: installed.join(", ") }
    : { name: "agent skill", ok: "warn", detail: "not installed for any coding agent", fix: "jev-browser install-skill" };
}

/** Check everything jev-browser needs and print the fix for anything missing. Returns the exit code. */
export async function doctor(jev: () => TypeSafeClient): Promise<number> {
  const config = (await Bun.file(CONFIG_PATH).exists()) ? CONFIG_PATH : `${CONFIG_PATH} (not created yet)`;
  const [browser, jevCheck, text] = await Promise.all([checkBrowser(), checkJev(jev), checkText()]);
  const checks: Check[] = [{ name: "config", ok: true, detail: config }, ...browser, jevCheck, text, checkSkill()];
  for (const c of checks) {
    const mark = c.ok === true ? "✓" : c.ok === "warn" ? "!" : "✗";
    console.log(`${mark} ${c.name.padEnd(15)} ${c.detail}`);
    if (c.ok !== true && c.fix) console.log(`  ${"".padEnd(15)} fix: ${c.fix}`);
  }
  const count = (ok: Check["ok"], word: string) => {
    const n = checks.filter((c) => c.ok === ok).length;
    return n ? `${n} ${word}${n > 1 ? "s" : ""}` : "";
  };
  const failed = count(false, "problem");
  const warned = count("warn", "warning");
  console.log(`\n${failed ? `${[failed, warned].filter(Boolean).join(", ")} found.` : `Ready${warned ? ` (${warned})` : ""}.`}`);
  return failed ? 1 : 0;
}
