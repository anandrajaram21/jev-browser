#!/usr/bin/env bun
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { runAgent, type Task } from "./agent.ts";
import { Browser } from "./browser.ts";
import { CONFIG_PATH, doctor, installSkill, loadConfig, setup } from "./setup.ts";
import { TextModel, textModelFromEnv } from "./text.ts";

const HELP = `jev-browser - fast browser agent: agent-browser acts, TypeSafe Jev decides

Usage: jev-browser [options] "<task>" [-- <agent-browser global flags>]
       jev-browser [options] --report <file|-> [-- <agent-browser global flags>]
       jev-browser <command>

Commands:
  setup                 Save your TypeSafe and OpenRouter API keys to the user config
                        (prompts on a terminal; otherwise saves the keys set in the environment)
  doctor                Check agent-browser, the browser, both API keys and the agent skill
  install-skill [--dir <skills-dir>]
                        Install the agent skill for Claude Code, Codex, Cursor and ~/.agents
                        (whichever exist), or into the given skills directories

Options:
  --session <name>      agent-browser session to drive (default: $AGENT_BROWSER_SESSION or "default")
  --url <url>           Open this URL first
  --input <key=value>   A literal value the agent may type (repeatable)
  --check <statement>   An end state that must hold when the task is done (repeatable)
  --report <file|->     Reproduce a bug report (file, or - for stdin): the text model turns it
                        into start URL, inputs, single-action steps, actual and expected
  --step <text>         An ordered step to carry out, e.g. a bug report's repro steps (repeatable).
                        The task is done when the last step is done
  --observe <statement> Something to verify on the final page, e.g. a bug's symptom (repeatable).
                        Reported as a probability; replaces the text-model answer
  --expect <statement>  The correct behaviour. With --observe, Jev gives a verdict:
                        bug reproduced vs expected behaviour vs neither
  --no-plan             Don't call the text model to extract goal/start URL/inputs/checks
                        (implied when --check is given: the caller has already planned)
  --no-vision           Disable the Jev screenshot (box) fallback
  --max-steps <n>       Give up after n actions (default 25)
  --min-confidence <n>  Below this Jev confidence, try the vision fallback (default 0.3)
  --done <p>            Probability at which Jev's "goal done" counts (default 0.85)
  --settle <ms>         Max wait for navigation after clicks/Enter (default 1500)
  --page-chars <n>      Page snapshot characters sent to Jev per step (default 12000)
  --json                Print the result as JSON on stdout
  -q, --quiet           No progress lines on stderr
  -v, --version         Print the version

Examples:
  jev-browser "search hacker news for bun 2.0 and open the top result"
  jev-browser --session work --url https://example.com/login --input email=a@b.co --check "The account dashboard is shown" "log in"
  jev-browser "find the price of the first result" -- --headed

Config: environment variables, then ./.env, then ${CONFIG_PATH}`;

// @typesafe-ai/sdk 0.7.0 locks `response.body` with getReader() and then calls
// `response.text()`, which Bun rejects ("Body already used"). Hand it a
// pre-buffered Response whose `body` getter is null so only the clone streams.
const bufferedFetch = async (input: string, init?: RequestInit) => {
  const r = await fetch(input, init);
  const res = new Response(await r.arrayBuffer(), { status: r.status, statusText: r.statusText, headers: r.headers });
  Object.defineProperty(res, "body", { get: () => null });
  return res;
};

const JEV_INPUT_USD_PER_MTOK = 0.042; // TypeSafe list price for jev-1.13/1.14 input; output is free

const jevClient = () => new TypeSafeClient({ fetch: bufferedFetch, timeout: 8000, logLevel: "error" });

async function main() {
  const command = process.argv[2];
  if (command === "setup") return setup();
  if (command === "install-skill") {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { dir: { type: "string", multiple: true } } });
    return installSkill(values.dir);
  }
  if (command === "doctor") {
    await loadConfig();
    process.exit(await doctor(jevClient));
  }

  const dashdash = process.argv.indexOf("--");
  const own = dashdash === -1 ? process.argv.slice(2) : process.argv.slice(2, dashdash);
  const passthrough = dashdash === -1 ? [] : process.argv.slice(dashdash + 1);

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      session: { type: "string" },
      url: { type: "string" },
      input: { type: "string", multiple: true },
      check: { type: "string", multiple: true },
      observe: { type: "string", multiple: true },
      expect: { type: "string" },
      step: { type: "string", multiple: true },
      report: { type: "string" },
      "no-plan": { type: "boolean" },
      "no-vision": { type: "boolean" },
      "max-steps": { type: "string" },
      "min-confidence": { type: "string" },
      done: { type: "string" },
      settle: { type: "string" },
      "page-chars": { type: "string" },
      json: { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) return console.log(pkg.version);
  const report = values.report === undefined ? undefined : values.report === "-" ? await Bun.stdin.text() : await Bun.file(values.report).text();
  const taskText = positionals.join(" ").trim();
  if (values.help || (!taskText && !report)) {
    console.log(HELP);
    process.exit(values.help ? 0 : 2);
  }

  await loadConfig();
  if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is not set; run `jev-browser setup`");
  const log = values.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`);

  const textCfg = textModelFromEnv();
  const text = textCfg ? new TextModel(textCfg) : undefined;
  const inputs = Object.fromEntries(
    (values.input ?? []).map((kv) => {
      const eq = kv.indexOf("=");
      if (eq < 1) throw new Error(`--input expects key=value, got "${kv}"`);
      return [kv.slice(0, eq), kv.slice(eq + 1)];
    }),
  );

  const callerParts = { observe: values.observe, expect: values.expect, steps: values.step };
  const browser = new Browser(values.session ?? process.env.AGENT_BROWSER_SESSION ?? "default", passthrough);
  // Launching a fresh session's browser takes ~0.5s; overlap it with planning.
  // A report almost always names its start URL, so open that speculatively.
  const guessedUrl = values.url ?? report?.match(/https?:\/\/[^\s"'<>)]+/)?.[0]?.replace(/[.,;:]+$/, "");
  const warm = report || (text && !values["no-plan"])
    ? browser.run("open", guessedUrl ?? "about:blank").then(() => guessedUrl, () => undefined)
    : undefined;

  let task: Task = { goal: taskText, startUrl: values.url, inputs, checks: values.check, ...callerParts };
  if (report) {
    if (!text) throw new Error("--report needs the text model (TEXT_MODEL_API_KEY); run `jev-browser setup`");
    const t0 = performance.now();
    const planned = await text.planReport(report);
    task = {
      goal: taskText || planned.goal,
      startUrl: values.url ?? planned.startUrl,
      inputs: { ...planned.inputs, ...inputs },
      checks: values.check,
      steps: values.step ?? planned.steps,
      observe: values.observe ?? planned.observe,
      expect: values.expect ?? planned.expect,
    };
    log(`plan (${Math.round(performance.now() - t0)}ms): ${JSON.stringify(task)}`);
  } else if (text && !values["no-plan"] && !values.check?.length && !values.step?.length) {
    const t0 = performance.now();
    const planned = await text.plan(taskText);
    task = { ...planned, startUrl: values.url ?? planned.startUrl, inputs: { ...planned.inputs, ...inputs }, ...callerParts };
    log(`plan (${Math.round(performance.now() - t0)}ms): ${JSON.stringify(task)}`);
  }

  // Count Jev tokens: input is billed ($0.042/MTok for jev-1.14), output is free.
  const jevRaw = jevClient();
  const jevUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const jev = Object.assign(Object.create(jevRaw), {
    systemOne: (...args: Parameters<TypeSafeClient["systemOne"]>) =>
      jevRaw.systemOne(...args).then((r) => {
        jevUsage.calls++;
        jevUsage.inputTokens += r.usage.input_tokens ?? 0;
        jevUsage.outputTokens += r.usage.output_tokens ?? 0;
        return r;
      }),
  }) as TypeSafeClient;

  const opened = await warm;
  const result = await runAgent(task, {
    browser,
    openedUrl: opened,
    jev,
    text,
    model: process.env.TYPESAFE_MODEL ?? "jev-latest",
    visionModel: process.env.TYPESAFE_VISION_MODEL ?? "jev-preview",
    maxSteps: Number(values["max-steps"] ?? 25),
    doneThreshold: Number(values.done ?? 0.85),
    minConfidence: Number(values["min-confidence"] ?? 0.3),
    vision: !values["no-vision"],
    settleMs: Number(values.settle ?? 1500),
    pageChars: Number(values["page-chars"] ?? 12_000),
    log,
  });

  const jevCostUsd = (jevUsage.inputTokens * JEV_INPUT_USD_PER_MTOK) / 1e6;
  const usage = {
    jev: { ...jevUsage, costUsd: jevCostUsd },
    text: text?.usage,
    totalUsd: jevCostUsd + (text?.usage.costUsd ?? 0),
  };
  log(`cost $${usage.totalUsd.toFixed(5)} · jev ${jevUsage.calls} calls ${jevUsage.inputTokens} in-tok · text ${text?.usage.calls ?? 0} calls ${text?.usage.inputTokens ?? 0}/${text?.usage.outputTokens ?? 0} tok`);

  if (values.json) console.log(JSON.stringify({ ...result, usage }, null, 2));
  else {
    if (result.answer) console.log(result.answer);
    if (result.verdict) {
      const pr = result.verdict.probabilities;
      console.log(`${result.verdict.reproduced ? "REPRODUCED" : "NOT REPRODUCED"} (bug ${pr.bug.toFixed(2)} · expected ${pr.expected.toFixed(2)} · neither ${pr.neither.toFixed(2)})`);
    }
    for (const [o, p] of Object.entries(result.observed ?? {})) console.log(`${p >= 0.5 ? "YES" : "NO "} ${p.toFixed(2)}  ${o}`);
    log(`${result.ok ? "ok" : `failed: ${result.reason}${result.error ? ` (${result.error})` : ""}`} · ${result.steps.length} actions · ${result.totalMs}ms · ${result.url}`);
  }
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`jev-browser: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
