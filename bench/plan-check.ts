// Planner consistency: does the report planner keep each report's key steps?
// Usage: TEXT_PLAN_MODEL=... bun bench/plan-check.ts [runs]
import { join } from "node:path";
import { loadConfig } from "../src/setup.ts";
import { TextModel, textModelFromEnv } from "../src/text.ts";

await loadConfig();

const runs = Number(process.argv[2] ?? 5);
const reports = (await Bun.file(join(import.meta.dir, "bugs.md")).text()).split("\n## ").slice(1).map((s) => `## ${s.trim()}`);
// Each report must yield steps matching every pattern, in order.
const must: Record<string, RegExp[]> = {
  B1: [/blue mug/i, /red kettle/i, /cart/i, /remove/i],
  B2: [/priya|name/i, /email/i, /password/i, /india|country/i, /terms/i, /create account/i],
  B3: [/buy milk/i, /add/i, /walk dog/i, /add/i, /buy milk/i, /active/i],
  B4: [/notifications/i, /email/i, /save/i, /reload|refresh/i, /notifications/i],
  B5: [/tea|search/i, /page 2|2/i],
};
const text = new TextModel(textModelFromEnv()!);
let ok = 0, total = 0;
const times: number[] = [];
for (const r of reports) {
  const id = r.slice(3, 5);
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const plan = await text.planReport(r).catch((e) => ({ steps: [String(e)], observe: [], expect: "" }));
    times.push(performance.now() - t);
    let k = 0;
    for (const step of plan.steps ?? []) if (k < must[id]!.length && must[id]![k]!.test(step)) k++;
    const good = k === must[id]!.length && plan.observe.length > 0 && !!plan.expect;
    total++; if (good) ok++;
    if (!good) console.log(`${id} MISS: ${JSON.stringify(plan.steps)} obs=${JSON.stringify(plan.observe)}`);
  }
}
times.sort((a, b) => a - b);
console.log(`${process.env.TEXT_PLAN_MODEL}: ${ok}/${total} plans complete · median ${Math.round(times[times.length >> 1]!)}ms · p90 ${Math.round(times[Math.floor(times.length * 0.9)]!)}ms`);
