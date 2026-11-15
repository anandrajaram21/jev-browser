// The only text generation in the loop. Jev chooses; this small, fast
// OpenAI-compatible model (gpt-oss-20b on Groq via OpenRouter by default)
// writes the few strings Jev can't: task inputs, free text, final answers.

export interface TextModelConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  providers: string[];
  reasoning?: string;
  /** Planning (task/bug report → steps) needs more smarts than answering; it can use its own model. */
  plan?: { model: string; providers: string[]; reasoning?: string };
}

export function textModelFromEnv(env = process.env): TextModelConfig | undefined {
  if (!env.TEXT_MODEL_API_KEY) return undefined;
  return {
    apiKey: env.TEXT_MODEL_API_KEY,
    baseURL: env.TEXT_MODEL_BASE_URL ?? "https://openrouter.ai/api/v1",
    model: env.TEXT_MODEL ?? "openai/gpt-oss-20b",
    providers: (env.TEXT_MODEL_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    reasoning: env.TEXT_MODEL_REASONING,
    plan: env.TEXT_PLAN_MODEL
      ? {
          model: env.TEXT_PLAN_MODEL,
          providers: (env.TEXT_PLAN_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          reasoning: env.TEXT_PLAN_REASONING,
        }
      : undefined,
  };
}

const FOCUS_STEP = /^(click|focus|tap|select)\b.*\b(field|input|box|textbox|textarea)\b/i;

export class TextModel {
  /** Tokens and OpenRouter-reported cost (USD) across all calls. */
  readonly usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  constructor(private readonly cfg: TextModelConfig) {}

  private async complete(system: string, user: string, json: boolean, planning = false, temperature = 0): Promise<string> {
    const m = (planning && this.cfg.plan) || this.cfg;
    const body: Record<string, unknown> = {
      model: m.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature,
    };
    if (json) body.response_format = { type: "json_object" };
    body.usage = { include: true };
    if (m.providers.length) body.provider = { order: m.providers, allow_fallbacks: true };
    if (m.reasoning && m.reasoning !== "none") body.reasoning = { effort: m.reasoning, exclude: true };

    const res = await fetch(`${this.cfg.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`text model ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    this.usage.calls++;
    this.usage.inputTokens += data.usage?.prompt_tokens ?? 0;
    this.usage.outputTokens += data.usage?.completion_tokens ?? 0;
    this.usage.costUsd += data.usage?.cost ?? 0;
    return data.choices[0]?.message.content?.trim() ?? "";
  }

  /** One tiny completion, to check the key and model work (`jev-browser doctor`). */
  async ping(): Promise<void> {
    await this.complete("Reply with OK.", "OK", false);
  }

  /** Split a natural-language task into a goal, an optional start URL and the literal values it will need to type. */
  async plan(task: string): Promise<{ goal: string; startUrl?: string; inputs: Record<string, string>; checks: string[] }> {
    const out = await this.complete(
      `You prepare tasks for a browser agent that can click and choose but cannot invent text.
Return JSON: {"goal": string, "start_url": string|null, "inputs": {name: value}, "checks": string[]}.
- goal: the task restated as a clear end state.
- start_url: the best URL to begin at (full https URL), or null if the task gives no hint and the current page should be used.
- inputs: every literal string the agent will need to type (search queries, names, emails, messages), keyed by a short snake_case name. Only values stated in or directly implied by the task. {} if none.
- checks: 1-3 short statements that are all true only once the task is finished, each verifiable from the final page and the list of actions taken (e.g. "Search results for the query are shown", "An order confirmation is shown"). Describe end states, not steps. Each check must be false before the task starts, so name the specific page or result that must be reached, not facts that are already visible on the start page. You have not seen the result page: describe outcomes semantically ("the order form has been submitted"), never guess exact wording, field names or formats. Use one check unless the task has clearly separate outcomes.`,
      task,
      true,
      true,
    );
    const parsed = JSON.parse(out) as { goal?: string; start_url?: string | null; inputs?: Record<string, unknown>; checks?: unknown[] };
    const inputs = Object.fromEntries(Object.entries(parsed.inputs ?? {}).map(([k, v]) => [k, String(v)]));
    const checks = (parsed.checks ?? []).map(String).filter(Boolean).slice(0, 3);
    return { goal: parsed.goal || task, startUrl: parsed.start_url || undefined, inputs, checks };
  }

  /** Turn a bug report into a runnable reproduction: start URL, typed values, one step per UI action, actual vs expected. */
  async planReport(report: string): Promise<{
    goal: string; startUrl?: string; inputs: Record<string, string>; steps: string[]; observe: string[]; expect?: string;
  }> {
    // The planner occasionally drops trailing steps (1 in ~12 for B4: no reload).
    // Sample two plans in parallel and keep the longer one; a truncated plan is
    // never longer than a complete one.
    const sample = (temperature: number) =>
      this.complete(
        `You turn a bug report into a reproduction plan for a browser agent that can click, type given values and choose options, but cannot invent text.
Return JSON: {"title": string, "start_url": string|null, "inputs": {name: value}, "steps": string[], "actual": string, "expected": string}.
- start_url: the full URL the steps begin at.
- inputs: every literal value to type, keyed by a short snake_case name.
- steps: ONE single UI action per step, in order, after opening start_url: one button/link/tab click, one field typed, one option chosen, one checkbox ticked, one key press, one reload. Typing into a field is a single step that names both the value and the field (e.g. "Type Priya Shah into the Full name field"); never add a separate step to click or focus a field first. Split compound steps ("add X and Y" becomes type X, click Add, type Y, click Add; "fill the form" becomes one step per field). Never include opening start_url itself.
- actual: the buggy behaviour, described only by what the final page shows on its own: text or element state such as "The total shows $47.00" or "The Email notifications switch is checked". Not styling, and not relative to earlier states ("back on", "again", "still").
- expected: the correct behaviour, phrased the same way.`,
        report,
        true,
        true,
        temperature,
      );
    // Wait for both (normally ~0.7s), but no more than 2s once a provider latency
    // spike hits; then use whatever has arrived. Racing to the first plan instead
    // let truncated plans win.
    const pending = [sample(0), sample(0.5)].map((pr) => pr.then((o) => o, () => undefined));
    const outs: string[] = [];
    pending.forEach((pr) => pr.then((o) => o !== undefined && outs.push(o)));
    await Promise.race([Promise.all(pending), Bun.sleep(2000)]);
    if (!outs.length) await Promise.race(pending.map((pr) => pr.then((o) => (o === undefined ? new Promise(() => {}) : o))).concat(Promise.all(pending)));
    const plans = outs.flatMap((o) => {
      try {
        return [JSON.parse(o) as { title?: string; start_url?: string | null; inputs?: Record<string, unknown>; steps?: unknown[]; actual?: string; expected?: string }];
      } catch {
        return [];
      }
    });
    if (!plans.length) throw new Error(`report planner returned invalid JSON: ${outs[0]?.slice(0, 200)}`);
    // Drop focus-only steps ("click the email field") right before a typing step;
    // they add a round trip and would make an over-split plan look "longer".
    for (const plan of plans) {
      const steps = (plan.steps ?? []).map(String);
      plan.steps = steps.filter((st, i) => !(FOCUS_STEP.test(st) && /^type\b/i.test(steps[i + 1] ?? "")));
    }
    const parsed = plans.reduce((a, b) => ((b.steps?.length ?? 0) > (a.steps?.length ?? 0) ? b : a));
    return {
      goal: `Reproduce: ${parsed.title || report.split("\n")[0]}`,
      startUrl: parsed.start_url || undefined,
      inputs: Object.fromEntries(Object.entries(parsed.inputs ?? {}).map(([k, v]) => [k, String(v)])),
      steps: (parsed.steps ?? []).map(String).filter(Boolean),
      observe: parsed.actual ? [parsed.actual] : [],
      expect: parsed.expected || undefined,
    };
  }

  /** Compose the text to type into one field, mid-run. */
  async write(goal: string, field: string, page: string, inputs: Record<string, string>): Promise<string> {
    return this.complete(
      "You fill in one field for a browser agent. Reply with only the exact text to type, nothing else.",
      `Goal: ${goal}\nKnown values: ${JSON.stringify(inputs)}\nField: ${field}\nPage:\n${page.slice(0, 6000)}`,
      false,
    );
  }

  /** Report back information the goal asked for, read from the final page. */
  async answer(goal: string, page: string): Promise<string> {
    return this.complete(
      "Answer the user's goal using only the page content. Be brief and exact. If the page doesn't contain the answer, say so.",
      `Goal: ${goal}\nPage:\n${page.slice(0, 12000)}`,
      false,
    );
  }
}
