// Runs the bench/bugs.md reproductions through jev-browser, the way a calling
// agent following the skill would, and reports time and verdicts.
// Usage: bun bench/jev-repro.ts [runs] [B1,B2,...]   (app must be running on :4173)
//   MODE=report  feed each bugs.md report through `--report` instead of hand-written flags
//   BASE=http://localhost:4174  point at another app instance (e.g. FIXED=1 control)
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:4173";
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

export const REPROS: Record<string, string[]> = {
  B1: [
    "--url", `${BASE}/shop`,
    "--step", "Add Blue Mug to the cart", "--step", "Add Red Kettle to the cart", "--step", "Open the cart", "--step", "Remove Blue Mug from the cart",
    "--observe", "The cart total still shows $47.00", "--expect", "The cart total shows $35.00",
    "Reproduce: removing an item from the cart doesn't update the total",
  ],
  B2: [
    "--url", `${BASE}/signup`,
    "--input", "name=Priya Shah", "--input", "email=priya+test@example.com", "--input", "password=hunter2hunter2",
    "--step", "Fill in name Priya Shah", "--step", "Fill in email priya+test@example.com", "--step", "Fill in password hunter2hunter2",
    "--step", "Choose country India", "--step", "Accept the terms", "--step", "Click Create account",
    "--observe", "An error says 'Please enter a valid email address'", "--expect", "The account is created (a welcome message is shown)",
    "Reproduce: can't sign up with a plus-address email",
  ],
  B3: [
    "--url", `${BASE}/todos`,
    "--input", "todo1=buy milk", "--input", "todo2=walk dog",
    "--step", "Type 'buy milk' into the New todo field", "--step", "Click Add", "--step", "Type 'walk dog' into the New todo field", "--step", "Click Add",
    "--step", "Tick 'buy milk' as done", "--step", "Click the Active filter",
    "--observe", "'buy milk' is still listed under the Active filter", "--expect", "Only 'walk dog' is listed under the Active filter",
    "Reproduce: completed todos still show under Active",
  ],
  B4: [
    "--url", `${BASE}/settings`,
    "--step", "Open the Notifications tab", "--step", "Turn off Email notifications", "--step", "Click Save changes",
    "--step", "Reload the page", "--step", "Open the Notifications tab again",
    "--observe", "Email notifications is switched on (checked)", "--expect", "Email notifications is switched off (unchecked)",
    "Reproduce: the email notifications setting doesn't stick after reload",
  ],
  B5: [
    "--url", `${BASE}/search`,
    "--input", "query=tea",
    "--step", "Type 'tea' into the search box", "--step", "Click Search", "--step", "Click the Page 2 link",
    "--observe", "Page 2 lists Brewing guide #1 to #5 again", "--expect", "Page 2 lists Brewing guide #6 onwards",
    "Reproduce: search page 2 shows the same results as page 1",
  ],
};

// bugs.md sections, with the app URL swapped for BASE.
const reports = Object.fromEntries(
  (await Bun.file(join(import.meta.dir, "bugs.md")).text())
    .split("\n## ")
    .slice(1)
    .map((sec) => [sec.split(" ")[0]!, `## ${sec.trim().replaceAll("http://localhost:4173", BASE)}\n`]),
);
const reportMode = process.env.MODE === "report";

const runs = Number(process.argv[2] ?? 1);
const only = process.argv[3]?.split(",");
const results: { bug: string; ms: number; ok: boolean; reason: string; actions: number; observed: string }[] = [];

for (let r = 0; r < runs; r++) {
  for (const [bug, args] of Object.entries(REPROS)) {
    if (only && !only.includes(bug)) continue;
    await fetch(`${BASE}/__reset`);
    const t = performance.now();
    const cliArgs = reportMode ? ["--report", "-"] : args;
    const proc = Bun.spawn(["bun", CLI, "--session", `repro-${bug}`, "--json", "-q", ...cliArgs], {
      stdin: reportMode ? new Blob([reports[bug]!]) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const ms = Math.round(performance.now() - t);
    try {
      const res = JSON.parse(out);
      const observed = res.verdict ? `${res.verdict.reproduced ? "BUG" : "no-bug"}(${res.verdict.probabilities.bug.toFixed(2)})` : "";
      results.push({ bug, ms, ok: res.ok, reason: res.reason, actions: res.steps.length, observed });
      console.log(`${bug} ${res.ok ? "ok " : "FAIL"} ${String(ms).padStart(5)}ms  ${res.steps.length} actions  observed=${observed || "-"}  ${res.ok ? "" : res.reason + " " + (res.error ?? "")}`);
      if (process.env.VERBOSE) for (const s of res.steps) console.log(`     ${s.move} (conf ${s.confidence.toFixed(2)}, jev ${s.jevMs}ms, act ${s.actMs}ms)`);
    } catch {
      console.log(`${bug} CRASH ${out.slice(0, 200)}`);
    }
    await Bun.spawn(["agent-browser", "--session", `repro-${bug}`, "close"]).exited;
  }
}
const ok = results.filter((r) => r.ok && r.observed.startsWith("BUG"));
console.log(`\nreproduced ${ok.length}/${results.length} · median ${results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)]}ms`);
