import { expect, test } from "bun:test";
import { samePage } from "./agent.ts";
import { describeLayout } from "./browser.ts";
import { absolute, cleanSteps, findAnswerFormat, findLabels, hasLabel, parsePlanJson, planRank, unbackedTyping } from "./text.ts";

const TASK = `A client reports: "The ISBN is missing on the book page."

Open http://localhost:8888/books/x/ and check the book details panel. Decide whether the report is valid.

Answer with exactly two lines:
VERDICT: VALID or NOT REPRODUCIBLE
EVIDENCE: one sentence on what you saw
`;

test("parsePlanJson accepts plans, with or without code fences, and rejects answers", () => {
  expect(parsePlanJson('{"steps": [], "start_url": null}')).toHaveLength(1);
  expect(parsePlanJson('```json\n{"goal": "x", "checks": []}\n```')).toHaveLength(1);
  expect(parsePlanJson("VERDICT: VALID\nEVIDENCE: the ISBN is shown")).toEqual([]);
  expect(parsePlanJson('{"VERDICT": "VALID"}')).toEqual([]);
  expect(parsePlanJson("[1, 2]")).toEqual([]);
});

test("cleanSteps drops focus-only steps before typing and window-size steps", () => {
  expect(cleanSteps(["Click the email field", "Type a@b.co into the email field", "Set the browser viewport to 375x812", "Click Save"]))
    .toEqual(["Type a@b.co into the email field", "Click Save"]);
});

test("findAnswerFormat copies the requested format verbatim", () => {
  expect(findAnswerFormat(TASK)).toBe("Answer with exactly two lines:\nVERDICT: VALID or NOT REPRODUCIBLE\nEVIDENCE: one sentence on what you saw");
  expect(findAnswerFormat("Search for tea and open the first result")).toBeUndefined();
});

test("findLabels maps the negative option to not reproduced", () => {
  expect(findLabels(TASK)).toEqual({ bug: "VALID", noBug: "NOT REPRODUCIBLE" });
  expect(findLabels("Reply with:\nRESULT: INVALID or VALID\n")).toEqual({ bug: "VALID", noBug: "INVALID" });
  expect(findLabels("Reply with:\nRESULT: RED or BLUE\n")).toBeUndefined();
});

test("hasLabel matches whole words and ignores a label inside a longer one", () => {
  expect(hasLabel("VERDICT: VALID", "VALID")).toBe(true);
  expect(hasLabel("VERDICT: INVALID", "VALID")).toBe(false);
  expect(hasLabel("VERDICT: NOT REPRODUCIBLE", "REPRODUCIBLE", "NOT REPRODUCIBLE")).toBe(false);
  expect(hasLabel("VERDICT: REPRODUCIBLE", "REPRODUCIBLE", "NOT REPRODUCIBLE")).toBe(true);
});

test("describeLayout says whether the page scrolls sideways", () => {
  expect(describeLayout([375, 375, 812, false])).toContain("no horizontal scrolling");
  expect(describeLayout([612, 375, 812, false])).toContain("scrolls sideways");
  expect(describeLayout([612, 375, 812, true])).toContain("clipped, no horizontal scrolling");
});

test("samePage ignores a trailing slash and the fragment", () => {
  expect(samePage("http://a.test/books/x/", "http://a.test/books/x#top")).toBe(true);
  expect(samePage("http://a.test/books/x/", "http://a.test/books/y/")).toBe(false);
  expect(samePage("http://a.test/?s=lantern", "http://a.test/?s=tea")).toBe(false);
});

test("planRank prefers the longer plan unless it types values it never declared", () => {
  const full = { inputs: {}, steps: ["Click Add Blue Mug", "Click Add Red Kettle", "Open the cart", "Remove Blue Mug"], actual: "a", expected: "b" };
  const padded = { inputs: {}, steps: ["Type Blue Mug into the search field", "Click Add Blue Mug", "Type Red Kettle into the search field", "Click Add Red Kettle", "Open the cart", "Remove Blue Mug"] };
  const truncated = { inputs: {}, steps: ["Click Add Blue Mug", "Click Add Red Kettle", "Open the cart"], actual: "a", expected: "b" };
  expect(unbackedTyping(padded)).toBe(2);
  expect(planRank(full)).toBeGreaterThan(planRank(padded));
  expect(planRank(full)).toBeGreaterThan(planRank(truncated));
  const typed = { inputs: { query: "tea" }, steps: ["Type tea into the search box", "Click Search"] };
  expect(unbackedTyping(typed)).toBe(0);
});

test("absolute drops comparisons with earlier states", () => {
  expect(absolute("Email notifications is back on")).toBe("Email notifications is on");
  expect(absolute("The total still shows $47.00")).toBe("The total shows $47.00");
  expect(absolute("It shows Brewing guide #1–#5 again.")).toBe("It shows Brewing guide #1–#5.");
});
