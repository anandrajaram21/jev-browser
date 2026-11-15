# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, …) working **on** this repository. If you only want to **use** jev-browser to drive a browser, read `skills/jev-browser/SKILL.md` instead.

## What this is

`jev-browser` is a Bun + TypeScript CLI. It reproduces bug reports, and runs other browser tasks, by putting TypeSafe's Jev model in a loop with the `agent-browser` CLI:

- **agent-browser** observes the page and acts on it. It runs locally, shares named sessions with anything else using agent-browser, and has no per-call cost.
- **Jev** makes every decision. It only answers questions: `choice` (pick a label), `noul` (a yes/no probability) and `box` (locate something on a screenshot). It cannot write text.
- **Small OpenRouter models** write the little text needed. gpt-oss-20b on Groq turns a bug report into steps (`--report`); llama-3.1-8b on Groq writes free text and final answers.

The speed comes from asking Jev one parallel request per round and chaining several actions per round. Read the README's "How it works" before changing `src/agent.ts`.

## Layout

```
src/cli.ts          argument parsing, .env loading, Jev client (with Bun fetch workaround), usage/cost reporting
src/agent.ts        the loop: observe → decide (one Jev request + parallel page-only verdict) → act (chain)
src/moves.ts        snapshot elements → complete moves ("click button X", "type email into textbox Y", …)
src/browser.ts      agent-browser subprocess wrapper + snapshot text parser
src/text.ts         OpenRouter client: task planning, bug-report planning, free text, answers
src/setup.ts        config loading, and the setup / doctor / install-skill commands
src/*.test.ts       offline unit tests (bun test)
scripts/build.ts    compiles release binaries, SHA256SUMS, Homebrew formula and npm packages into dist/
install.sh          curl | sh installer that downloads a release binary
.claude-plugin/     Claude Code plugin marketplace manifest (ships the skill)
.github/workflows/  CI (test, check, build) and tag-triggered release
skills/jev-browser/ the Claude Code skill other agents load to use the CLI
bench/app/server.ts test app with 5 planted bugs (FIXED=1 fixes them all; used as a false-positive control)
bench/bugs.md       the 5 bug reports, written the way users write them
bench/jev-repro.ts  runs the reports through the CLI and scores verdicts (MODE=report, BASE=…)
bench/plan-check.ts checks the report planner keeps every key step
bench/text-models.ts latency and quality probe for candidate OpenRouter text models
```

## Commands

```bash
bun install
bun test                                   # offline unit tests, must pass
bun check                                  # type check, must be clean
bun src/cli.ts --help
bun scripts/build.ts --current             # compiled binary for this machine in dist/

# End-to-end (needs TYPESAFE_API_KEY and TEXT_MODEL_API_KEY in .env, plus agent-browser installed)
bun bench/app/server.ts 4173 &             # buggy app
FIXED=1 bun bench/app/server.ts 4174 &     # same app with every bug fixed
MODE=report bun bench/jev-repro.ts 3                               # expect "reproduced 15/15"
MODE=report BASE=http://localhost:4174 bun bench/jev-repro.ts 2    # expect "reproduced 0/10"
bun bench/jev-repro.ts 2                   # explicit --step/--observe/--expect flags instead of --report
TEXT_PLAN_MODEL=openai/gpt-oss-20b bun bench/plan-check.ts 6       # planner completeness
bun bench/text-models.ts 3                 # compare text models
```

`curl localhost:4173/__reset` resets the app's server-side settings (bug B4); `jev-repro.ts` does this before each bug. Stop the app servers when you're done.

## Rules for changes

- **Measure before and after.** Any change to `src/agent.ts`, `src/moves.ts`, the prompts in `src/text.ts` or a model choice must be checked on both the buggy and the fixed app (commands above), and the numbers reported. A speedup that costs a false positive or a false negative is a regression.
- **Speed claims need the head-to-head.** The goal is to be at least 2× faster than a coding agent driving agent-browser directly. Check it by running two agents in parallel on `bench/bugs.md`, one allowed only `jev-browser` and the other only `agent-browser`, each on its own app instance (e.g. 4175 and 4173). Record timestamps around each bug and verify the final browser states yourself. The README's benchmark table has the history; add new rounds to it.
- **Keep Jev requests to one per round.** New questions go into the existing parallel request, or into the page-only verdict request, not a new sequential call. Each extra sequential Jev call costs about 280ms per round.
- **Don't show the verdict request the goal, steps or history.** That pulled verdicts toward "expected" and caused a false negative (README, round 2).
- **Chaining safety rules exist for a reason** (`canContinue`, the `used` element set, `CHAIN_MIN_CONFIDENCE`, `RETRY_MIN_CONFIDENCE`, the `spent` set). Each one fixed an observed failure, such as a resubmitted form, an overwritten field, or a destructive guess. Don't loosen them without a benchmark showing it's safe.
- **Page state is `snapshot -i` plus `get text body`.** `snapshot -c` drops text such as totals and status messages, and Jev then misjudges pages.
- **Report planning samples two plans and keeps the longer one,** because gpt-oss-20b sometimes drops trailing steps. Keep that unless `plan-check.ts` shows a model that never does.
- **Match the surrounding style:** Bun APIs (`Bun.spawn`, `Bun.file`), no new dependencies without a reason, short comments that say *why*, and constants named and grouped at the top of `agent.ts`.
- **Secrets:** `.env` holds `TYPESAFE_API_KEY` and `TEXT_MODEL_API_KEY`. It's git-ignored; never commit it, print it, or paste it into logs or docs.
- **Browser sessions:** close only the agent-browser sessions you created (`agent-browser --session <name> close`). Never `close --all`, because other sessions may belong to the user.

## Gotchas

- `@typesafe-ai/sdk` 0.7.0 throws "Body already used" under Bun. `bufferedFetch` in `src/cli.ts` works around it; keep passing it to `TypeSafeClient`.
- Bun only auto-loads `.env` from the current directory, so `cli.ts` also loads the `.env` next to `package.json`. That lets the CLI run from any directory.
- `agent-browser batch --json` returns an array, not the usual `{success, data}` object. `Browser.run` expects the latter, so don't use `batch` through it.
- `agent-browser session` doesn't launch a browser; `open about:blank` does. The CLI warms the browser by opening the report's URL while the planner runs.
- Release binaries are `bun build --compile` output: `.env.example` and `SKILL.md` are embedded through `with { type: "text" }` imports in `src/setup.ts`. Anything else the CLI reads at runtime must be embedded the same way, because a binary has no checkout next to it.
- Jev `choice` questions allow at most 255 options. `decide` splits larger move lists into chunks within the same request.
- Jev's answers vary a little between identical calls. Run each benchmark at least twice before drawing conclusions.
