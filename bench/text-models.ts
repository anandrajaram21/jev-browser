// Latency/quality probe for OpenRouter text models on jev-browser's two real prompts.
// Usage: bun bench/text-models.ts [runs]
const env = process.env;
const RUNS = Number(process.argv[2] ?? 3);
type Cand = { model: string; provider?: Record<string, unknown>; reasoning?: Record<string, unknown> };
const lat = { sort: "latency" };
const CANDS: Cand[] = [
  { model: "openai/gpt-oss-20b", provider: { order: ["Groq"], allow_fallbacks: false }, reasoning: { effort: "low", exclude: true } },
  { model: "openai/gpt-oss-120b", provider: { order: ["Groq"], allow_fallbacks: false }, reasoning: { effort: "low", exclude: true } },
  { model: "openai/gpt-oss-120b", provider: { order: ["Cerebras"], allow_fallbacks: false }, reasoning: { effort: "low", exclude: true } },
  { model: "meta-llama/llama-3.1-8b-instruct", provider: { order: ["Groq"], allow_fallbacks: false } },
  { model: "meta-llama/llama-3.1-8b-instruct", provider: lat },
  { model: "z-ai/glm-5.3-flash", provider: lat, reasoning: { enabled: false } },
  { model: "qwen/qwen3.7-flash", provider: lat, reasoning: { enabled: false } },
  { model: "inclusionai/ling-3.0-flash", provider: lat },
  { model: "inclusionai/ling-3.0-tiny", provider: lat },
  { model: "mistralai/mistral-nemo", provider: lat },
  { model: "nvidia/nemotron-3.5-lightning", provider: lat, reasoning: { enabled: false } },
  { model: "google/gemini-2.5-flash-lite", provider: lat },
  { model: "openai/gpt-4.1-nano", provider: lat },
  { model: "mistralai/ministral-3b-2512", provider: lat },
  { model: "deepseek/deepseek-v4.1-flash", provider: lat, reasoning: { enabled: false } },
];

const REPORT = `Bug: Removing an item from the cart doesn't update the total.
Steps: 1. Go to http://localhost:4173/shop 2. Add "Blue Mug" and "Red Kettle" to the cart 3. Open the cart 4. Remove "Blue Mug"
Expected: total shows $35.00. Actual: total still shows $47.00.`;
const PLAN_SYS = `You prepare tasks for a browser agent that can click and choose but cannot invent text.
Return JSON: {"goal": string, "start_url": string|null, "inputs": {name: value}, "checks": string[]}.
inputs: every literal string to type, snake_case keys, {} if none. checks: 1-3 end states, false before the task starts, described semantically.`;
const PAGE = `Cart\nBlue Mug $12.00 Remove\nRed Kettle $35.00 Remove\nSubtotal $47.00\nShipping Free\nTotal $47.00\nCheckout\n`.repeat(1) + "Footer links About Careers Press Help ".repeat(150);
const ANSWER_SYS = "Answer the user's goal using only the page content. Be brief and exact.";

async function call(c: Cand, system: string, user: string, json: boolean) {
  const body: Record<string, unknown> = { model: c.model, temperature: 0, max_tokens: 400, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  if (json) body.response_format = { type: "json_object" };
  if (c.provider) body.provider = c.provider;
  if (c.reasoning) body.reasoning = c.reasoning;
  const t = performance.now();
  try {
  const r = await fetch(`${env.TEXT_MODEL_BASE_URL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${env.TEXT_MODEL_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const j: any = await r.json().catch(() => ({}));
  return { ms: Math.round(performance.now() - t), out: j.choices?.[0]?.message?.content ?? `ERR ${r.status} ${JSON.stringify(j.error ?? j).slice(0, 120)}`, provider: j.provider };
  } catch (e) {
    return { ms: Math.round(performance.now() - t), out: `ERR ${(e as Error).name}`, provider: undefined };
  }
}
const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const rows = await Promise.all(CANDS.map(async (c) => {
  const plan: number[] = [], ans: number[] = [];
  let planOk = 0, ansOk = 0, provider = "", sample = "";
  for (let i = 0; i < RUNS; i++) {
    const p = await call(c, PLAN_SYS, REPORT, true);
    plan.push(p.ms); provider ||= p.provider ?? "";
    try { const o = JSON.parse(p.out.replace(/^```json|```$/g, "")); if (o.start_url?.includes("4173") && Array.isArray(o.checks) && o.checks.length) planOk++; } catch { sample ||= p.out.slice(0, 80); }
    const a = await call(c, ANSWER_SYS, `Goal: What total does the cart show?\nPage:\n${PAGE}`, false);
    ans.push(a.ms); if (a.out.includes("47")) ansOk++; else sample ||= a.out.slice(0, 80);
  }
  return { id: `${c.model}${c.provider && "order" in c.provider ? `@${(c.provider.order as string[])[0]}` : ""}`, provider, plan: med(plan), ans: med(ans), planOk, ansOk, sample };
}));
rows.sort((a, b) => a.plan + a.ans - (b.plan + b.ans));
for (const r of rows) console.log(`${r.id.padEnd(46)} ${String(r.provider).padEnd(14)} plan ${String(r.plan).padStart(5)}ms ${r.planOk}/${RUNS}  answer ${String(r.ans).padStart(5)}ms ${r.ansOk}/${RUNS}  ${r.sample}`);
