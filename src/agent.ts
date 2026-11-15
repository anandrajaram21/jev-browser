// The observe → decide → act loop. One Jev request per step answers, in
// parallel: is the goal done, does it need a written answer, and which move next.

import { box, choice, image, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, type Snapshot } from "./browser.ts";
import { buildMoves, type Move } from "./moves.ts";
import type { TextModel } from "./text.ts";

const MAX_CHOICES = 255;
const VISION_MIN_CONFIDENCE = 0.3;
const LOST_CONFIDENCE = 0.2; // two steps in a row below this: Jev is guessing, hand back to the caller
const CHAIN_MIN_CONFIDENCE = 0.85; // a speculative pick for a later step must be at least this sure to run unobserved
const MAX_LOOKAHEAD = 8; // steps whose moves are picked in one request

export interface AgentOptions {
  browser: Browser;
  jev: TypeSafeClient;
  text?: TextModel;
  model: string;
  visionModel: string;
  maxSteps: number;
  doneThreshold: number;
  minConfidence: number; // below this, try a vision step instead of the chosen move
  vision: boolean;
  settleMs: number;
  pageChars: number; // snapshot text sent to Jev; Jev latency grows with input size
  openedUrl?: string; // already opened (speculatively, during planning); skip re-opening it
  log: (line: string) => void;
}

export interface StepRecord {
  step: number;
  url: string;
  moveId?: string;
  move: string;
  confidence: number;
  doneP: number;
  jevMs: number;
  actMs: number;
}

export interface RunResult {
  ok: boolean;
  reason: "done" | "max_steps" | "stuck" | "uncertain" | "error";
  goal: string;
  url: string;
  answer?: string;
  observed?: Record<string, number>; // observe statement → Jev probability it holds on the final page
  verdict?: { reproduced: boolean; probabilities: Record<"bug" | "expected" | "neither", number> };
  error?: string;
  steps: StepRecord[];
  totalMs: number;
}

export interface Task {
  goal: string;
  startUrl?: string;
  inputs: Record<string, string>;
  checks?: string[]; // end-state statements; all must hold for the task to count as done
  observe?: string[]; // statements to verify on the final page (e.g. a bug's symptom); reported, not acted on
  expect?: string; // the correct behaviour; with `observe`, Jev picks bug vs expected vs neither
  steps?: string[]; // ordered steps (e.g. a bug report's repro steps); Jev works through them one at a time
}

export async function runAgent(task: Task, opts: AgentOptions): Promise<RunResult> {
  const { browser, log } = opts;
  const started = performance.now();
  const steps: StepRecord[] = [];
  const history: string[] = [];
  const repeats = new Map<string, number>(); // `${url} ${moveId}` → times chosen
  const spent = new Set<string>(); // `${url} ${moveId}` of button clicks that navigated away; never repeat (e.g. a submit)
  let lostSteps = 0;
  let stepIdx = 0; // first task step not yet confirmed done
  let executedUpTo = -1; // highest step index an action has been run for (confirmation pending)
  let snap: Snapshot | undefined;

  const finish = (r: Omit<RunResult, "goal" | "steps" | "totalMs" | "url">): RunResult => ({
    ...r, goal: task.goal, url: snap?.url ?? "", steps, totalMs: Math.round(performance.now() - started),
  });

  try {
    if (task.startUrl && task.startUrl !== opts.openedUrl) {
      const t = performance.now();
      await browser.run("open", task.startUrl);
      log(`   open ${task.startUrl} (${Math.round(performance.now() - t)}ms)`);
    }

    for (let step = 1; step <= opts.maxSteps; step++) {
      const prevUrl = snap?.url;
      snap = await browser.snapshot();
      if (prevUrl && prevUrl !== snap.url && history.length) history[history.length - 1] += ` → now on ${snap.url}`;
      if (prevUrl && prevUrl !== snap.url && steps.at(-1)?.moveId?.endsWith(":click")) spent.add(`${prevUrl} ${steps.at(-1)!.moveId}`);
      const moves = buildMoves(snap.elements, task.inputs, !!opts.text).filter((m) => {
        const key = `${snap!.url} ${m.id}`;
        return (repeats.get(key) ?? 0) < 3 && !spent.has(key);
      });

      const t0 = performance.now();
      const decision = await decide(task, stepIdx, executedUpTo, snap, moves, history, opts);
      const jevMs = Math.round(performance.now() - t0);
      for (; stepIdx < decision.stepIdx; stepIdx++) log(`   step ${stepIdx + 1} done: ${task.steps![stepIdx]}`);

      // Jev's choice and its checks are separate questions; finish when the checks
      // are confident, or when Jev picks "finish" and the checks lean yes.
      if (decision.done || (decision.move?.kind === "finish" && decision.doneP >= 0.5)) {
        log(`✓ done after ${step - 1} actions (jev ${jevMs}ms, p=${decision.doneP.toFixed(2)})`);
        let answer: string | undefined;
        if (decision.needsAnswer && opts.text && !task.observe?.length) {
          const t = performance.now();
          answer = await opts.text.answer(task.goal, snap.visibleText);
          log(`   answer (${Math.round(performance.now() - t)}ms)`);
        }
        return finish({ ok: true, reason: "done", answer, observed: decision.observed, verdict: decision.verdict });
      }

      lostSteps = decision.confidence < LOST_CONFIDENCE ? lostSteps + 1 : 0;
      if (lostSteps >= 2) {
        log(`? no confident next move (conf ${decision.confidence.toFixed(2)}, p(done) ${decision.doneP.toFixed(2)}); handing back`);
        return finish({ ok: false, reason: "uncertain", error: "Jev has no confident next move; the goal may already be met or need a different approach" });
      }

      let move = decision.move;
      let desc = move?.desc ?? "";
      const t1 = performance.now();
      if (!move || decision.confidence < opts.minConfidence) {
        const clicked = opts.vision ? await visionClick(task, history, opts) : undefined;
        if (!clicked) {
          if (!move) return finish({ ok: false, reason: "stuck", error: "no usable moves on this page" });
        } else {
          desc = clicked;
          move = undefined;
        }
      }
      if (move) desc = await execute(move, task, snap, opts);
      if (task.steps) executedUpTo = Math.max(executedUpTo, stepIdx);

      // Chain: run the picks for the following steps without re-observing, as long
      // as nothing so far can have changed the page (fills, selects, toggles), each
      // pick is confident, and no element is used twice (a step that needs two
      // moves would otherwise get its field overwritten by the next step). The next
      // request confirms which steps really completed.
      let last: Move | undefined = move;
      const used = new Set(move ? [refOf(move)] : []);
      for (const [i, c] of decision.chain.entries()) {
        if (!last || !c.move || c.move.kind !== "cmd" || c.confidence < CHAIN_MIN_CONFIDENCE) break;
        if (c.move.id.startsWith("scroll:") || used.has(refOf(c.move))) break;
        if (!(await canContinue(last, c.move, snap.url, opts))) break;
        await execute(c.move, task, snap, opts);
        executedUpTo = stepIdx + 1 + i;
        used.add(refOf(c.move));
        last = c.move;
        desc += ` ⇢ [${executedUpTo + 1}] ${c.move.desc}`;
        repeats.set(`${snap.url} ${c.move.id}`, (repeats.get(`${snap.url} ${c.move.id}`) ?? 0) + 1);
      }
      if (last?.kind === "cmd" && last.navigates) await browser.settle(opts.settleMs);
      const actMs = Math.round(performance.now() - t1);

      if (move) repeats.set(`${snap.url} ${move.id}`, (repeats.get(`${snap.url} ${move.id}`) ?? 0) + 1);
      history.push(desc);
      steps.push({ step, url: snap.url, moveId: move?.id, move: desc, confidence: decision.confidence, doneP: decision.doneP, jevMs, actMs });
      log(`${String(step).padStart(2)} ${task.steps ? `[${stepIdx + 1}] ` : ""}${desc}  (conf ${decision.confidence.toFixed(2)}, p(done) ${decision.doneP.toFixed(2)}, jev ${jevMs}ms, act ${actMs}ms)`);
    }
    return finish({ ok: false, reason: "max_steps" });
  } catch (err) {
    return finish({ ok: false, reason: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

interface Decision {
  done: boolean;
  doneP: number;
  needsAnswer: boolean;
  move?: Move;
  confidence: number;
  stepIdx: number; // first step not confirmed done after this request
  chain: { move?: Move; confidence: number }[]; // speculative picks for the steps after `move`'s step
  observed?: Record<string, number>;
  verdict?: RunResult["verdict"];
}

type Pick = { choice: string; confidence: number; probabilities: Record<string, number> };
// A step we already ran a confident move for needs less evidence to count as
// done than one nothing has been done for yet.
const STEP_DONE_EXECUTED = 0.5;
const STEP_DONE_UNTOUCHED = 0.8;
const RETRY_MIN_CONFIDENCE = 0.5; // re-acting on an already-acted-on step needs at least this

async function decide(
  task: Task, stepIdx: number, executedUpTo: number, snap: Snapshot, moves: Move[], history: string[], opts: AgentOptions,
): Promise<Decision> {
  const steps = task.steps ?? [];
  const state = {
    goal: task.goal,
    ...(steps.length ? { steps } : {}),
    available_inputs: task.inputs,
    current_url: snap.url,
    visible_text: snap.visibleText.slice(0, opts.pageChars),
    interactive_elements: snap.text.slice(0, opts.pageChars),
    actions_so_far: history.slice(-10),
  };
  // Specific end-state checks separate "the info is somewhere on screen" from
  // "the task is actually finished" far better than one generic done question.
  const checks = task.checks?.length
    ? task.checks
    : steps.length
      ? []
      : ["Given the current page and the actions so far, the goal is achieved: every requested action has been carried out, and any requested information is visible on the current page."];
  const ask = (step?: string) =>
    step
      ? `Which single action carries out (the next part of) this step: "${step}"?`
      : "Which single action makes the most progress toward the goal from the current page?";

  // Up to 255 moves: one choice question. More: one choice per chunk in the same
  // (parallel) request; the most probable chunk winner wins. A second runoff
  // request between winners cost ~300ms per step for no measurable accuracy gain.
  const chunks: Move[][] = [];
  for (let i = 0; i < moves.length; i += MAX_CHOICES) chunks.push(moves.slice(i, i + MAX_CHOICES));
  const criteria = (ms: Move[]) => Object.fromEntries(ms.map((m) => [m.id, m.desc]));
  const questions: Record<string, ReturnType<typeof noul> | ReturnType<typeof choice>> = {
    needs_answer: noul("The goal asks for information to be reported back (not only for an action to be performed)."),
  };
  checks.forEach((c, i) => (questions[`check_${i}`] = noul(c)));
  // Steps: confirm the current step and any steps already acted on, and pick a
  // move for each upcoming step, all in this one (parallel) request.
  const verifyTo = Math.min(steps.length - 1, Math.max(stepIdx, executedUpTo));
  for (let j = stepIdx; j <= verifyTo; j++) {
    questions[`done_${j}`] = noul(`Judging by the actions so far and the current page, this step has been fully carried out: "${steps[j]}"`);
  }
  const pickTo = Math.min(steps.length - 1, Math.max(verifyTo + 1, stepIdx + MAX_LOOKAHEAD - 1));
  for (let j = stepIdx; j <= pickTo; j++) chunks.forEach((c, i) => (questions[`pick_${j}_${i}`] = choice(ask(steps[j]), criteria(c))));
  if (!steps.length) chunks.forEach((c, i) => (questions[`pick_x_${i}`] = choice(ask(), criteria(c))));
  // Observations are judged in a separate request that sees only the page (no
  // goal, steps or history, which pulled verdicts toward "expected" in testing).
  // It runs in parallel with the step request, so it costs no time, and is read
  // on the final step.
  const [{ answers }, judged] = await Promise.all([
    opts.jev.systemOne({ state, questions, model: opts.model }),
    task.observe?.length ? judgePage(task, snap, opts) : undefined,
  ]);
  const p = (k: string) => (answers[k] as { noul: number }).noul;
  const byId = new Map(moves.map((m) => [m.id, m]));
  const pickFor = (key: string | number) => {
    if (!chunks.length) return { move: undefined, confidence: 0, pick: undefined };
    const pick = chunks
      .map((_, i) => answers[`pick_${key}_${i}`] as Pick)
      .reduce((best, q) => (q.probabilities[q.choice]! > best.probabilities[best.choice]! ? q : best));
    return { move: byId.get(pick.choice), confidence: pick.confidence, pick };
  };

  if (process.env.JEV_DEBUG) {
    const dbg = Object.entries(answers).filter(([k]) => !k.startsWith("pick_")).map(([k, a]) => `${k}=${"noul" in a ? a.noul.toFixed(2) : "choice" in a ? a.choice : "?"}`);
    opts.log(`   jev: ${dbg.join(" ")}`);
  }
  let next = stepIdx;
  while (next <= verifyTo && p(`done_${next}`) >= (next <= executedUpTo ? STEP_DONE_EXECUTED : STEP_DONE_UNTOUCHED)) next++;
  const checksP = checks.length ? Math.min(...checks.map((_, i) => p(`check_${i}`))) : 1;
  const doneP = steps.length ? (next >= steps.length ? Math.min(checksP, p(`done_${steps.length - 1}`)) : 0) : checksP;
  const { observed, verdict } = judged ?? {};
  const base = {
    done: steps.length ? next >= steps.length && checksP >= opts.doneThreshold : doneP >= opts.doneThreshold,
    doneP, needsAnswer: p("needs_answer") >= 0.5, stepIdx: next, observed, verdict, chain: [],
  };
  if (base.done || !moves.length) return { ...base, confidence: 0 };

  let first = pickFor(steps.length ? next : "x");
  // Jev unsure how to redo a step we already acted on: assume it took effect
  // rather than guessing (a guess here clicked "Remove Red Kettle" in testing).
  while (steps.length && next <= executedUpTo && first.confidence < RETRY_MIN_CONFIDENCE) {
    next++;
    if (next >= steps.length) return { ...base, stepIdx: next, done: checksP >= opts.doneThreshold, confidence: 0 };
    first = pickFor(next);
  }
  base.stepIdx = next;
  const chain = [];
  for (let j = next + 1; steps.length && j <= pickTo; j++) {
    const { move, confidence } = pickFor(j);
    chain.push({ move, confidence });
  }
  // "finish" with checks leaning no: take the runner-up instead of stalling.
  if (first.pick?.choice === "finish" && doneP < 0.5) {
    const [id, pr] = Object.entries(first.pick.probabilities).filter(([k]) => k !== "finish").sort((a, b) => b[1] - a[1])[0] ?? [];
    if (id) return { ...base, chain, move: byId.get(id), confidence: pr! };
  }
  return { ...base, chain, move: first.move, confidence: first.confidence };
}

/**
 * Whether a chain may run `next` right after `prev` without asking Jev again.
 * Fills, selects and toggles leave the page in place. After an in-page button
 * click, a cheap snapshot (~50ms, vs ~300ms for Jev) confirms we're on the same
 * URL and `next`'s element still exists. Links, Enter, reload and back always
 * stop the chain, and so does anything without a target element.
 */
async function canContinue(prev: Move, next: Move, url: string, opts: AgentOptions): Promise<boolean> {
  if (prev.kind !== "cmd" || !prev.navigates) return true;
  const isButton = prev.id.endsWith(":click") && prev.desc.startsWith("click button");
  const ref = next.kind === "cmd" ? next.args.find((a) => a.startsWith("@"))?.slice(1) : undefined;
  if (!isButton || !ref) return false;
  await opts.browser.settle(opts.settleMs);
  const now = await opts.browser.run<{ origin: string; refs: Record<string, unknown> }>("snapshot", "-i");
  return now.origin === url && ref in now.refs;
}

/**
 * Judge the reported (bug) and expected behaviour against the page alone. The
 * verdict is asked twice with the options in different orders and averaged, to
 * cancel ordering bias in one parallel request.
 */
async function judgePage(task: Task, snap: Snapshot, opts: AgentOptions) {
  const state = {
    current_url: snap.url,
    visible_text: snap.visibleText.slice(0, opts.pageChars),
    interactive_elements: snap.text.slice(0, opts.pageChars),
  };
  const bug = task.observe!.join(" ");
  const instructions = "Which best describes what the current page shows?";
  const questions: Record<string, ReturnType<typeof noul> | ReturnType<typeof choice>> = {};
  task.observe!.forEach((o, i) => (questions[`observe_${i}`] = noul(o)));
  if (task.expect) {
    const neither = "Neither: the page shows something else";
    questions.verdict_a = choice(instructions, { bug, expected: task.expect, neither });
    questions.verdict_b = choice(instructions, { expected: task.expect, bug, neither });
  }
  const { answers } = await opts.jev.systemOne({ state, questions, model: opts.model });
  const observed = Object.fromEntries(task.observe!.map((o, i) => [o, (answers[`observe_${i}`] as { noul: number }).noul]));
  if (!task.expect) return { observed, verdict: undefined };
  const [a, b] = [answers.verdict_a, answers.verdict_b] as Pick[];
  const avg = (k: string) => (a!.probabilities[k]! + b!.probabilities[k]!) / 2;
  const probabilities = { bug: avg("bug"), expected: avg("expected"), neither: avg("neither") };
  return { observed, verdict: { reproduced: probabilities.bug > Math.max(probabilities.expected, probabilities.neither), probabilities } };
}

/** The element a move acts on, so a chain never touches the same element twice. */
function refOf(move: Move): string {
  if (move.kind === "write") return move.ref;
  if (move.kind === "cmd") return move.args.find((a) => a.startsWith("@")) ?? move.id;
  return move.id;
}

async function execute(move: Move, task: Task, snap: Snapshot, opts: AgentOptions): Promise<string> {
  if (move.kind === "finish") return move.desc; // only reached when checks lean yes but under the threshold
  if (move.kind === "cmd") {
    await opts.browser.run(...move.args);
    return move.desc;
  }
  const text = await opts.text!.write(task.goal, move.field, snap.text, task.inputs);
  await opts.browser.run("fill", `@${move.ref}`, text);
  return `type "${text.length > 60 ? `${text.slice(0, 59)}…` : text}" into ${move.field}`;
}

/** Fallback for low confidence or pages without a usable accessibility tree: let Jev point at the screenshot. */
async function visionClick(task: Task, history: string[], opts: AgentOptions): Promise<string | undefined> {
  const path = join(tmpdir(), `jev-browser-${process.pid}-${Date.now()}.jpg`);
  const [, vp] = await Promise.all([opts.browser.screenshot(path), opts.browser.viewport()]);
  const shot = image(await Bun.file(path).arrayBuffer());
  const { answers } = await opts.jev.systemOne(
    {
      state: { screenshot: shot, goal: task.goal, actions_so_far: history.slice(-10) },
      questions: { target: box(`The single on-screen element to click next to make progress toward the goal: ${task.goal}`) },
      model: opts.visionModel,
    },
    { headers: { "TypeSafe-Danger-Zone-Images": "true" } },
  );
  await Bun.file(path).delete().catch(() => {});
  const { box: b, confidence } = answers.target;
  if (confidence !== null && confidence < VISION_MIN_CONFIDENCE) {
    opts.log(`   vision declined (box conf ${confidence.toFixed(2)})`);
    return undefined;
  }
  const x = ((b.left + b.right) / 2) * vp.width;
  const y = ((b.top + b.bottom) / 2) * vp.height;
  await opts.browser.clickAt(x, y);
  await opts.browser.settle(opts.settleMs);
  return `vision click at (${Math.round(x)}, ${Math.round(y)})${confidence !== null ? ` conf ${confidence.toFixed(2)}` : ""}`;
}
