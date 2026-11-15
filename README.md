# jev-browser

A fast browser agent for reproducing bug reports. [agent-browser](https://github.com/vercel-labs/agent-browser) clicks and types, [TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) makes every decision, and small Groq-hosted models handle the little text that has to be written.

```bash
gh issue view 123 | jev-browser --session repro --report -
# REPRODUCED (bug 0.98 · expected 0.01 · neither 0.01)
# ok · 2 actions · 2160ms · http://localhost:4173/shop
# cost $0.00051 · jev 6 calls 8707 in-tok · text 2 calls 946/319 tok
```

When a coding agent hands bug reports to `jev-browser` instead of driving agent-browser itself, it reproduces them **2.2× faster** (11.6s vs 26.0s for five reports, all correct). Each repro costs about **$0.0005–0.0008**. See [Benchmarks](#benchmarks).

- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Usage](#usage)
- [CLI reference](#cli-reference)
- [Using it from coding agents](#using-it-from-coding-agents)
- [How it works](#how-it-works)
- [Cost](#cost)
- [Benchmarks](#benchmarks)
- [Troubleshooting](#troubleshooting)
- [Developing](#developing)

## Requirements

| | Version used | Notes |
|---|---|---|
| [Bun](https://bun.sh) | 1.4.4 | Runs the TypeScript directly; there's no build step |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | 0.41.0 | `brew install agent-browser` or `npm i -g agent-browser`, then `agent-browser install` to download Chrome |
| TypeSafe API key | | For Jev. Sign up at [typesafe.ai](https://typesafe.ai) |
| OpenRouter API key | | For the planner and text models. Get one at [openrouter.ai](https://openrouter.ai) |

## Install

You need agent-browser plus a TypeSafe key and an OpenRouter key (see [Requirements](#requirements)). Bun isn't needed: releases ship as one standalone binary.

```bash
# 1. agent-browser and its Chrome (skip if you have them)
npm i -g agent-browser && agent-browser install      # or: brew install agent-browser

# 2. jev-browser (macOS and Linux, x64 and arm64)
curl -fsSL https://raw.githubusercontent.com/anandrajaram21/jev-browser/main/install.sh | sh
#   or: npm i -g @anandrajaram21/jev-browser
#   or: brew install anandrajaram21/tap/jev-browser   (also installs agent-browser)

# 3. keys, agent skill, check
jev-browser setup           # prompts for both keys, saves ~/.config/jev-browser/config (mode 600)
jev-browser install-skill   # Claude Code, Codex, Cursor and ~/.agents, whichever you have
jev-browser doctor          # agent-browser, browser launch, both keys, skill
```

`install.sh` puts the binary in `~/.local/bin`. Set `JEV_BROWSER_INSTALL_DIR` to put it somewhere else, or `JEV_BROWSER_VERSION=v0.1.0` to pin a release. On Windows, download `jev-browser-windows-x64.exe` from [Releases](https://github.com/anandrajaram21/jev-browser/releases) (untested).

To upgrade, run `jev-browser update` (or `jev-browser update 0.2.0` for a specific release). It downloads the release for your platform, checks it against `SHA256SUMS` and replaces the binary in place. Homebrew and npm installs print `brew upgrade jev-browser` or `npm i -g @anandrajaram21/jev-browser@latest` instead, so the package manager stays in charge.

For agents and CI without a terminal, `setup` saves the keys already in the environment instead of prompting: `TYPESAFE_API_KEY=… TEXT_MODEL_API_KEY=… jev-browser setup`.

### From source

```bash
git clone git@github.com:anandrajaram21/jev-browser.git
cd jev-browser
bun install
cp .env.example .env        # then fill in the two keys (or use `bun src/cli.ts setup`)
bun link                    # puts `jev-browser` on your PATH (bin: src/cli.ts)
jev-browser --help
```

Check it works end to end with the bundled test app:

```bash
bun bench/app/server.ts 4173 &
jev-browser --session smoke --report - <<'EOF'
Steps: Go to http://localhost:4173/shop. Add "Blue Mug" and "Red Kettle" to the cart. Open the cart and remove "Blue Mug".
Expected: the total shows $35.00. Actual: the total still shows $47.00.
EOF
# REPRODUCED (bug 0.98 · expected 0.01 · neither 0.02)
agent-browser --session smoke close; kill %1
```

## Configuration

Settings come from, in order of precedence: environment variables, `.env` in the current directory, the `.env` next to `package.json` in a source checkout, and the user config `~/.config/jev-browser/config` (or `$XDG_CONFIG_HOME/jev-browser/config`, or the path in `JEV_BROWSER_CONFIG`). `jev-browser setup` writes the user config from `.env.example` with your keys filled in, so it gets the recommended models below.

| Variable | Default | What it does |
|---|---|---|
| `TYPESAFE_API_KEY` | (required) | Jev API key |
| `TYPESAFE_MODEL` | `jev-latest` | Jev model for decisions |
| `TYPESAFE_VISION_MODEL` | `jev-preview` | Jev model for the screenshot (box) fallback |
| `TEXT_MODEL_API_KEY` | (none) | OpenRouter key. Without it there's no `--report`, no planning and no free text |
| `TEXT_MODEL_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint |
| `TEXT_MODEL` | `openai/gpt-oss-20b` | Writes free text and answers; `.env.example` sets the faster `meta-llama/llama-3.1-8b-instruct` |
| `TEXT_MODEL_PROVIDERS` | (none) | OpenRouter provider order, comma-separated, e.g. `Groq` |
| `TEXT_MODEL_REASONING` | (none) | `low`/`medium`/`high` for reasoning models, or `none` |
| `TEXT_PLAN_MODEL` | same as `TEXT_MODEL` | Planner for `--report` and plain tasks. Use `openai/gpt-oss-20b` |
| `TEXT_PLAN_PROVIDERS` | (none) | e.g. `Groq` |
| `TEXT_PLAN_REASONING` | (none) | e.g. `low` |
| `AGENT_BROWSER_SESSION` | `default` | Session to drive when `--session` isn't given |
| `AGENT_BROWSER_*` | | Any other agent-browser setting (e.g. `AGENT_BROWSER_HEADED=1`); see `agent-browser --help` |

Recommended settings (`.env.example`, and what `setup` writes):

```
TYPESAFE_API_KEY=
TYPESAFE_MODEL=jev-latest
TYPESAFE_VISION_MODEL=jev-preview
TEXT_MODEL_API_KEY=
TEXT_MODEL_BASE_URL=https://openrouter.ai/api/v1
TEXT_MODEL=meta-llama/llama-3.1-8b-instruct
TEXT_MODEL_REASONING=none
TEXT_MODEL_PROVIDERS=Groq
TEXT_PLAN_MODEL=openai/gpt-oss-20b
TEXT_PLAN_PROVIDERS=Groq
TEXT_PLAN_REASONING=low
```

## Usage

### Reproduce a bug report (the main use)

Give it the report: a file, stdin, or piped from your issue tracker. The report needs a full URL for where the steps start.

```bash
jev-browser --session repro --report issue.md
gh issue view 123 | jev-browser --session repro --report -
jev-browser --session repro --report - <<'EOF'
Steps: Go to http://localhost:4173/settings, open the Notifications tab, turn off Email notifications,
click Save changes, then reload the page and open Notifications again.
Expected: Email notifications is off. Actual: it's back on.
EOF
```

The output is `REPRODUCED` or `NOT REPRODUCED`, with probabilities for **bug** (the reported behaviour), **expected** and **neither**. A weak verdict (bug and expected within about 0.3 of each other), or `neither`, means: look at the page, or re-run with explicit steps.

### Reproduce with explicit steps

When there's no written report, or the planner got something wrong, pass the plan yourself. Use **one `--step` per single UI action**; that's what lets a whole form run in one Jev request.

```bash
jev-browser --session repro --url http://localhost:4173/signup \
  --input name="Priya Shah" --input email=priya+test@example.com --input password=hunter2hunter2 \
  --step "Fill in name Priya Shah" --step "Fill in email priya+test@example.com" \
  --step "Fill in password hunter2hunter2" --step "Choose country India" \
  --step "Accept the terms" --step "Click Create account" \
  --observe "An error says 'Please enter a valid email address'" \
  --expect "A welcome message is shown" \
  "Reproduce: can't sign up with a plus-address email"
```

- `--input key=value`: the literal values that can be typed. Jev can only choose where a value goes, not invent one.
- `--observe` / `--expect`: describe what the page itself shows (a total, a message, a checkbox being checked). Don't describe styling ("crossed out") or compare with earlier states ("back on").

### Other browser tasks

```bash
jev-browser "Search Wikipedia for Grace Hopper and tell me her date of birth"
jev-browser --url https://example.com/login --input email=a@b.co \
  --check "The account dashboard is shown" "Log in"
```

Without `--check`, the planner writes its own end-state checks; with `--check`, it isn't called at all. For tasks like these, jev-browser is roughly as fast as an agent driving agent-browser itself. Its advantage is on multi-step flows.

### Checking a claim, with a fixed answer format

A plain task that asks to verify something is planned as a check, the same way as a report, and can be passed word for word:

```bash
jev-browser --session race --report - <<'EOF'   # or pass the same text as the positional task
A client reports: "The ISBN is missing on the book page for The Lantern Keeper's Daughter."
Open http://localhost:8888/books/the-lantern-keepers-daughter/ and check the book details panel. Decide whether the report is valid.

Answer with exactly two lines:
VERDICT: VALID or NOT REPRODUCIBLE
EVIDENCE: one sentence on what you saw
EOF
# VERDICT: VALID
# EVIDENCE: The ISBN field is not present in the book details panel, which only displays …
```

- The task text is given to the planner as data, so an instruction like "Answer with exactly two lines" is kept as the answer format instead of being answered.
- A check with no steps (the start page already shows what to check) is judged on that page with no actions.
- Jev still decides the verdict. The text model only writes it in the requested format, with the task's own verdict words (`VALID` / `NOT REPRODUCIBLE`). With a format, stdout holds only that answer; the `REPRODUCED` line moves to stderr.
- "Set the viewport to 375x812" is applied before the page is judged (`--viewport 375x812` does the same). Every snapshot includes the page's content width against the viewport, so "the page scrolls sideways" can be judged.
- `--answer-format "<format>"` sets the format when the task doesn't.

### Sharing a browser with agent-browser

jev-browser drives the agent-browser **session** you name with `--session` (or `AGENT_BROWSER_SESSION`). It shares the same daemon, tabs, cookies and refs with you, Claude Code, or scripts using that session. When it finishes, carry on from the exact page:

```bash
jev-browser --session s --report issue.md
agent-browser --session s screenshot repro.png
agent-browser --session s get text body
```

Flags after `--` go to agent-browser, e.g. `jev-browser … -- --headed` to watch it, or `-- --profile Default` to use your Chrome login.

## CLI reference

```
jev-browser [options] "<task>" [-- <agent-browser global flags>]
jev-browser [options] --report <file|-> [-- <agent-browser global flags>]
```

| Option | Default | |
|---|---|---|
| `--session <name>` | `$AGENT_BROWSER_SESSION` or `default` | agent-browser session to drive |
| `--url <url>` | | Open this URL first |
| `--report <file\|->` | | Reproduce a bug report; the planner turns it into URL, inputs, steps, actual and expected |
| `--step <text>` | | One ordered step, a single UI action (repeatable) |
| `--input <key=value>` | | A literal value that may be typed (repeatable) |
| `--observe <text>` | | The reported (buggy) behaviour to check on the final page (repeatable) |
| `--expect <text>` | | The correct behaviour; with `--observe`, gives a bug/expected/neither verdict |
| `--check <text>` | | End state required for a plain task to count as done (repeatable); skips planning |
| `--answer-format <text>` | | Write the final answer in this format (found in the task text when planned) |
| `--viewport <WxH>` | | Set the browser viewport first, e.g. `375x812`; it stays set for the session |
| `--no-plan` | | Never call the planner |
| `--no-vision` | | Disable the screenshot (box) fallback |
| `--max-steps <n>` | 25 | Maximum decision rounds |
| `--min-confidence <p>` | 0.3 | Below this move confidence, try the vision fallback |
| `--done <p>` | 0.85 | Check probability that counts as done |
| `--settle <ms>` | 1500 | Maximum wait for navigation after clicks, Enter, reload or back |
| `--page-chars <n>` | 12000 | Characters of page text and of the element tree sent to Jev |
| `--json` | | Print the full result as JSON on stdout |
| `-q, --quiet` | | No progress output on stderr |

**Output:** the verdict or answer goes to stdout; progress, timing and cost go to stderr. **Exit codes:** `0` = finished (for repros, check the verdict), `1` = didn't finish or errored, `2` = no task or report given.

**`--json`** prints the following (values from a real run of the cart report):

```jsonc
{
  "ok": true,
  "reason": "done",                // done | max_steps | stuck | uncertain | error
  "warnings": ["…"],               // only when something needs a look, e.g. the verdict matched neither
  "goal": "Reproduce: …",
  "url": "http://localhost:4173/shop",
  "verdict": { "reproduced": true, "probabilities": { "bug": 0.975, "expected": 0.01, "neither": 0.015 } },
  "observed": { "The total shows $47.00": 0.98 },
  "answer": "…",                   // only for plain tasks that ask for information
  "error": "…",                    // only when ok is false
  "steps": [{ "step": 1, "url": "http://localhost:4173/shop", "moveId": "e9:click",
              "move": "click button \"Add Blue Mug to cart\" ⇢ [2] click button \"Add Red Kettle to cart\" ⇢ [3] click button \"Cart (0)\"",
              "confidence": 1, "doneP": 0, "jevMs": 295, "actMs": 383 }],
  "totalMs": 1515,
  "usage": { "jev": { "calls": 6, "inputTokens": 8768, "outputTokens": 2301, "costUsd": 0.000368 },
             "text": { "calls": 2, "inputTokens": 918, "outputTokens": 353, "costUsd": 0.000156 },
             "totalUsd": 0.000524 }
}
```

`reason: "uncertain"` means Jev had no confident next move for two rounds in a row. The goal may already be met, or it may need a different approach. jev-browser stops rather than guess. `reason: "stuck"` with `error: "looping: …"` means three actions in a row left the page unchanged. A verdict where `neither` wins also ends as `uncertain` (exit 1), with the verdict and any formatted answer still included: treat it as "look at the page", not as "not reproduced".

Errors name the stage that failed: `planner (<model>): …`, `jev (<model>): …`, `agent-browser <command>: …` or `text model …`.

## Using it from coding agents

`skills/jev-browser/SKILL.md` is an agent skill. It tells the agent when to hand work to jev-browser, to prefer `--report`, and how to write steps and observations. Install it any of these ways:

```bash
jev-browser install-skill                           # copies the skill bundled in the binary into ~/.claude, ~/.codex, ~/.cursor
                                                    # and ~/.agents skills folders that exist (or --dir <skills-dir>)
npx skills add anandrajaram21/jev-browser           # the cross-agent skills CLI
```

or, in Claude Code, as a plugin:

```
/plugin marketplace add anandrajaram21/jev-browser
/plugin install jev-browser@jev-browser
```

Re-run `install-skill` after `jev-browser update` so the skill matches the CLI. If you develop jev-browser, symlink the skill instead so it follows your checkout (`install-skill` leaves symlinks alone):

```bash
mkdir -p ~/.claude/skills && ln -s "$PWD/skills/jev-browser" ~/.claude/skills/jev-browser
```

Other agents (Codex, Cursor, …) can use the same file as instructions. The short version:

1. Use a named session: `--session <name>`.
2. Have a bug report? Pipe it to `--report -`.
3. Otherwise pass `--url`, `--input`, one `--step` per UI action, and `--observe`/`--expect`.
4. Trust confident verdicts. Re-run with explicit flags if the verdict is weak or `neither`.
5. Continue on the same page with `agent-browser --session <name> …`.

`AGENTS.md` has the instructions for agents working **on** this repository.

## How it works

```
bug report ─► plan (gpt-oss-20b ×2, ~0.7s, overlapped with opening the start URL)
          ─► look ─► one Jev request: which steps are done? a move for every remaining step ─► run a chain of moves ─┐
               ▲                                                                                                     │
               └─────────────────────────────────────────────────────────────────────────────────────────────────────┘
          ─► page-only Jev verdict, asked in parallel every round: bug vs expected vs neither
```

1. **Plan**: gpt-oss-20b turns the report (or a plain task) into a start URL, inputs, single-action steps, actual vs expected behaviour, and any requested answer format and window size. The text goes in as data between tags, so a task that says "Answer with…" is planned rather than answered. It's sampled twice in parallel and the longer plan is kept, because the model occasionally drops trailing steps, unless the longer plan types values it never declared (an invented search step once won this way). If neither sample is valid JSON it's asked once more. Comparisons with earlier states ("still", "again", "back on") are removed from actual and expected, since the verdict only sees the final page. Meanwhile, the URL found in the text is opened, so the ~0.5s browser launch overlaps planning.
2. **Look** (~60ms): `agent-browser snapshot -i` (interactive elements with `@eN` refs and their checked/selected state), `get text body` (everything a user can read) and a layout measure (content width against the viewport, i.e. whether the page scrolls sideways) run in parallel. `snapshot -c` isn't used because it drops text such as totals and status messages.
3. **Moves** (`src/moves.ts`): each element becomes complete actions, e.g. `click button "Add"`, `type email into textbox "Email"` or `choose "India" in combobox "Country"`, plus Enter, scroll, back, reload and finish. Jev answers each question independently, so it picks a whole move rather than a verb and a target separately. Lists over 255 moves are split into chunks within the same request.
4. **Decide** (~280ms): one Jev request confirms the steps already acted on and picks a move for every remaining step (up to 8 ahead) against the current page. A second request runs in parallel, sees only the page (no goal, steps or history) and judges `--observe` vs `--expect`. The verdict is asked twice with the options in different orders and averaged.
5. **Act (chain):** the picks run back to back. The chain carries on through fills, selects and toggles. After an in-page button click, a 50ms snapshot confirms the URL is unchanged and the next element still exists. It stops at links, Enter, reload and back, at any pick below 0.85 confidence, and at a pick that would reuse an element already used in the chain. A whole form takes one request.
6. **Safety:**
   - A step already acted on counts as done at p ≥ 0.5; a step nothing has been done for needs p ≥ 0.8.
   - A step that was acted on is never redone on a guess below 0.5.
   - A click that navigated away is never repeated on that page.
   - Two low-confidence rounds in a row end the run as `uncertain`.
   - An action that left the page unchanged isn't repeated on that page, and three such rounds in a row end the run as `stuck` (this stops scroll up/down/reload loops).
   - A check with `--observe` but no steps or checks is read-only: it's judged on the page it opened, with no actions.
   - If no move is confident enough, Jev finds the target on a screenshot (`box`) and the agent clicks it, but only when the box confidence is at least 0.5.
   - agent-browser's "Inspected target navigated or closed" error is retried after the page loads (a navigating command such as `back` counts as done).

The `@typesafe-ai/sdk` 0.7.0 client fails under Bun ("Body already used"); `src/cli.ts` passes it a buffered `fetch` to work around this.

## Cost

Measured on the five bundled bug reports:

| | Per bug |
|---|---|
| Jev (4–10 calls, 7–14k input tokens, $0.042 per 1M input; output free) | $0.0003–0.0006 |
| Planner (`--report` only; gpt-oss-20b ×2 on Groq) | ~$0.00015 |
| agent-browser and Chrome | $0, local |
| **Total** | **$0.0005–0.0008** (about $0.60 per 1,000 repros) |

With explicit `--step`/`--observe`/`--expect` flags there's no planner call. The calling agent's own model tokens cost more than all of this, and the one-call-per-bug flow keeps those low too.

### Text model choice

Medians of 3 runs on jev-browser's real prompts (`bun bench/text-models.ts`), via OpenRouter, Nov 2026:

| Model (provider) | $/1M in / out | Plan JSON | Answer |
|---|---|---|---|
| llama-3.1-8b (Groq) | 0.05 / 0.08 | 253ms | 149ms |
| gpt-oss-20b (Groq) | 0.075 / 0.30 | 305ms | 492ms |
| gpt-oss-120b (Groq) | 0.15 / 0.60 | 376ms | 222ms |
| gpt-oss-120b (Cerebras) | 0.35 / 0.75 | 466ms | 404ms |
| deepseek-v4.1-flash | 0.05 / 0.20 | 1051ms | 470ms |
| gemini-2.5-flash-lite | 0.10 / 0.40 | 1038ms | 642ms |

llama-3.1-8b is the closest replacement for Mercury on speed and price, but it's too weak to turn reports into steps: it put steps out of order and invented CSS selectors. Planning uses gpt-oss-20b, which produced complete plans 30/30 times in `bench/plan-check.ts`.

## Benchmarks

`bench/app/server.ts` is a small app with five planted bugs: a cart total that doesn't update, plus-address emails rejected at signup, completed todos shown under "Active", a setting that doesn't persist across a reload, and search page 2 repeating page 1. `bench/bugs.md` has the reports, written the way users write them. With `FIXED=1` the same app runs with every bug fixed, which catches false positives.

```bash
bun bench/app/server.ts 4173 &
FIXED=1 bun bench/app/server.ts 4174 &
MODE=report bun bench/jev-repro.ts 3                               # expect reproduced 15/15
MODE=report BASE=http://localhost:4174 bun bench/jev-repro.ts 2    # expect reproduced 0/10
```

Latest standalone result (v0.3.0): 15/15 reproduced on the buggy app and 0/10 on the fixed app, at a median of about 2.8s per bug including browser launch (2.4s on the fixed app). With explicit flags: 10/10 and 0/10, median 2.2s. `plan-check`: 30/30 complete plans.

### Agent → jev-browser vs agent → agent-browser

In each round, two Claude Code agents (Opus 5.5) ran in parallel on the same five reports, each on its own app instance. One could only call `jev-browser`; the other could only call `agent-browser`. Each recorded timestamps around every bug, and the final browser states were checked independently afterwards.

| Round | What changed | Agent → jev-browser | Agent → agent-browser | Speedup |
|---|---|---|---|---|
| 1 | one Jev request per action | 20.9s (B3 retried) | 25.3s | 1.2× |
| 2 | step chaining | 28.2s (false negative on B3, 3 runs) | 25.0s | 0.9× |
| 3 | page-only verdict, `--report` | 21.2s (planner dropped the B4 reload) | 31.2s | 1.5× |
| 4 | two plans, keep the longer | **11.6s** (1 call per bug) | 26.0s | **2.2×** |

Round 4, per bug: B1 2.1s vs 4.7s · B2 1.8s vs 4.6s · B3 2.6s vs 4.2s · B4 3.0s vs 6.0s · B5 2.1s vs 6.5s. All ten repros were correct.

An earlier comparison on general browsing tasks (httpbin form, HN, Wikipedia) found jev-browser roughly even with agent-browser. Its advantage comes from multi-step flows, where a calling agent would otherwise spend one model turn every few actions.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Anything about setup | Run `jev-browser doctor`; it prints the fix for each failed check |
| `TYPESAFE_API_KEY is not set` | `jev-browser setup`, or export it |
| `--report needs the text model` | `jev-browser setup` to add `TEXT_MODEL_API_KEY` |
| `planner (…): returned invalid JSON` | Both samples and the retry failed. Re-run, or pass `--url`/`--step`/`--observe`/`--expect` yourself |
| `reason: stuck`, `looping` | Three actions in a row didn't change the page. Look at the page, then pass explicit `--step`s |
| `Body already used` | You're calling `TypeSafeClient` without `bufferedFetch` (see `src/cli.ts`) |
| `agent-browser …: Unknown ref` | The page changed under a chain; re-run |
| `reason: uncertain` | Jev had no confident move. Look at the page (`agent-browser --session s screenshot`), then re-run with explicit `--step`s |
| Verdict `neither` or weak | Rephrase `--observe`/`--expect` as text or element state the page shows, or check the steps actually ran (`--json` → `steps`) |
| Slow first run | A new session launches Chrome (~0.5s). Reuse a `--session` for back-to-back repros |
| Want to watch it | `jev-browser … -- --headed` |

## Developing

```bash
bun test          # offline unit tests
bun check         # type check
bun run build     # standalone binaries, SHA256SUMS, Homebrew formula and npm packages in dist/
bun scripts/build.ts --current   # just this machine's binary
```

### Releasing

Bump `version` in `package.json` and `.claude-plugin/plugin.json` (the build checks they match), merge, then push a matching tag (`git tag v0.2.0 && git push origin v0.2.0`). `.github/workflows/release.yml` tests, builds every target on macOS and creates the GitHub release that `install.sh` downloads from. Two optional steps run only when their repository secrets are set:

- `NPM_TOKEN` publishes `@anandrajaram21/jev-browser` and its per-platform packages. The unscoped `jev-browser` name on npm belongs to someone else. Override the scope with `NPM_SCOPE` in `scripts/build.ts`.
- `HOMEBREW_TAP_TOKEN` (a token with write access to `anandrajaram21/homebrew-tap`) pushes `Formula/jev-browser.rb` to that tap. Create the tap repo first.

See `AGENTS.md` for the architecture, the measuring rules every change must follow, and known gotchas.
