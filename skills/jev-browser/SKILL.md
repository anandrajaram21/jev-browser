---
name: jev-browser
description: Hand a self-contained browser task (navigate, search, fill and submit a form, open something and read a fact off it) to jev-browser, a fast agent that drives agent-browser with TypeSafe Jev choosing each action (~0.3s per step). Use for well-defined, mostly mechanical web tasks where speed matters; drive agent-browser directly instead for exploratory work, debugging a page, or anything needing judgment about what the user wants.
---

# jev-browser

`jev-browser` runs a fast observe → decide → act loop on an agent-browser session: it snapshots the page, Jev picks one complete move (click/fill/select/scroll/back/finish), agent-browser runs it, repeat until Jev's success checks pass. A small text model (gpt-oss-20b) only plans the task up front, writes free text when needed, and phrases the final answer.

## Install (if `jev-browser` isn't on PATH)

```bash
curl -fsSL https://raw.githubusercontent.com/anandrajaram21/jev-browser/main/install.sh | sh
jev-browser doctor    # prints the fix for anything missing
```

It needs agent-browser (`npm i -g agent-browser && agent-browser install`) and two API keys, which the user saves with `jev-browser setup`. Ask the user for the keys; never guess them or print them.

## Run it

```bash
jev-browser --session <name> "<task in plain English>"
```

- **Always pass the session you are using with agent-browser** (`--session`, or `AGENT_BROWSER_SESSION`). jev-browser drives that same daemon, tabs and cookies, so you can inspect or continue with `agent-browser --session <name> ...` afterwards.
- **Fast path: plan it yourself.** Pass the start URL, every literal value to type, and 1–2 end-state checks. This skips jev-browser's own planning call and makes its done-detection much more reliable:

  ```bash
  jev-browser --session s --url https://en.wikipedia.org --input query="Grace Hopper" \
    --check "Grace Hopper's Wikipedia article is open" \
    "Search Wikipedia for Grace Hopper using the search box and report her date of birth"
  ```

  Write checks as end states that are false at the start ("the order form has been submitted (the page now shows the server's response)", "the comments page of the #1 story is open"). Don't guess exact wording or field names on pages you haven't seen.
- **Reproducing a bug report: hand over the report itself.** This is the fastest path because you don't have to write out steps. jev-browser's planner turns the report into a start URL, typed values, one step per UI action, and actual vs expected behaviour. It then runs them and prints `REPRODUCED` / `NOT REPRODUCED` with probabilities:

  ```bash
  jev-browser --session s --report - <<'EOF'
  <paste the bug report: steps, expected, actual>
  EOF
  # or: gh issue view 123 | jev-browser --session s --report -
  ```

  The report needs a full URL for where the steps start. If the verdict is weak (bug and expected within ~0.3 of each other) or says `neither`, re-run with explicit flags as below instead of guessing.
- **Explicit repro flags** (when there's no written report, or to fix a plan): pass the steps as `--step`, **one per single UI action** (one click, one field typed, one option chosen, one reload), in order. Add `--observe` for the reported actual behaviour and `--expect` for the expected behaviour. Jev picks moves for all the steps in one request and chains them, re-checking the page only when it might have changed, then gives a verdict. Splitting steps finely is what makes this fast: a whole form is one request. Example:

  ```bash
  jev-browser --session s --url http://localhost:4173/shop \
    --step "Add Blue Mug to the cart" --step "Add Red Kettle to the cart" --step "Open the cart" --step "Remove Blue Mug from the cart" \
    --observe "The cart total still shows \$47.00" --expect "The cart total shows \$35.00" \
    "Reproduce: removing an item from the cart doesn't update the total"
  ```

  ```bash
  # "Fill the signup form and submit" becomes one step per action:
  --input email=priya+test@example.com --step "Fill in name Priya Shah" --step "Fill in email priya+test@example.com" \
    --step "Choose country India" --step "Accept the terms" --step "Click Create account"
  ```

  Describe `--observe`/`--expect` by text or element state the page actually shows (a total, a message, a checkbox being checked), not by styling such as "crossed out". The output is `REPRODUCED` or `NOT REPRODUCED` with probabilities for bug / expected / neither. Steps can include reloads ("Reload the page"), navigation, typing (pass literal values as `--input` too), checkboxes, selects and tabs. To reproduce several bugs, run them in parallel with separate `--session` names in a single shell command (`cmd1 & cmd2 & wait`).
- Without `--check` or `--step`, a small model plans from the task text alone (slower, less reliable).
- If it exits with `uncertain`, Jev had no confident next move. The goal may already be met, so look at the page with agent-browser before retrying.
- Answers to questions are printed on stdout; progress goes to stderr. Use `--json` for a structured result (`ok`, `reason`, `answer`, `url`, per-step moves and timings).
- Exit code 0 means Jev judged the task done. Non-zero means `max_steps`, `stuck` or `error`: take over with agent-browser from the page it stopped on.

## Good fits

- "Search Wikipedia for Grace Hopper and tell me her date of birth"
- "Go to https://httpbin.org/forms/post, order a large pizza with bacon for Ada Lovelace (ada@example.com) and submit"
- "On Hacker News, open the comments of the #1 story"

## Limits

- Jev only chooses among moves built from the accessibility tree; it can't type text it wasn't given unless the text model writes it.
- Pages with no accessibility tree fall back to a screenshot + Jev `box` click (`--no-vision` to disable).
- Logins, payments and irreversible actions run without confirmation: only hand those over when the user asked for them.
- Tune with `--max-steps`, `--done`, `--min-confidence`, `--settle`; pass agent-browser global flags after `--` (e.g. `-- --headed`).
