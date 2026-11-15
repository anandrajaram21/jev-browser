// Thin async wrapper over the agent-browser CLI. Every call goes to the same
// daemon session, so tabs, cookies and refs are shared with any other
// agent-browser user (you, Claude Code, scripts) on that session.

export interface PageElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  attrs: Record<string, string | true>;
  parent?: string; // ref of the closest ancestor that has a ref
}

export interface Snapshot {
  url: string;
  text: string; // interactive accessibility tree with refs
  visibleText: string; // document.body.innerText: everything a user can read, which the tree omits
  layout: string; // viewport size and whether the page scrolls sideways, which neither text shows
  elements: PageElement[];
}

export class BrowserError extends Error {}

// The page navigated while agent-browser was evaluating in it. A navigating
// command has done its job by then; a read just needs the new page to load.
const TRANSIENT = /Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id/i;
const NAVIGATING = new Set(["back", "forward", "reload", "open", "click", "press", "mouse"]);

// Content width against the viewport. Overflow hidden on <html>/<body> clips
// wide content, so the page doesn't scroll sideways even when it's wider.
const LAYOUT_JS = `(() => { const s = document.scrollingElement || document.documentElement;
  const clipped = [document.documentElement, document.body].some((e) => e && /hidden|clip/.test(getComputedStyle(e).overflowX));
  return [s.scrollWidth, innerWidth, innerHeight, clipped]; })()`;

export function describeLayout([contentWidth, width, height, clipped]: [number, number, number, boolean]): string {
  const view = `viewport ${width}x${height}px, page content ${contentWidth}px wide`;
  if (contentWidth <= width + 1) return `${view}: fits the viewport width, no horizontal scrolling`;
  return clipped
    ? `${view}: wider than the viewport but clipped, no horizontal scrolling`
    : `${view}: wider than the viewport, the page scrolls sideways (horizontal scrolling)`;
}

export class Browser {
  constructor(
    readonly session: string,
    private readonly globalArgs: string[] = [],
  ) {}

  async run<T = any>(...args: string[]): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runOnce<T>(...args);
      } catch (err) {
        if (attempt >= 3 || !(err instanceof BrowserError) || !TRANSIENT.test(err.message)) throw err;
        await this.runOnce("wait", "--load", "domcontentloaded").catch(() => {});
        if (NAVIGATING.has(args[0]!)) return {} as T;
      }
    }
  }

  private async runOnce<T>(...args: string[]): Promise<T> {
    const proc = Bun.spawn(["agent-browser", "--session", this.session, ...this.globalArgs, "--json", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    let parsed: { success: boolean; data: T; error: string | null };
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new BrowserError(`agent-browser ${args[0]}: ${(err || out).trim()}`);
    }
    if (!parsed.success) throw new BrowserError(`agent-browser ${args.join(" ")}: ${parsed.error}`);
    return parsed.data;
  }

  // `snapshot -c` drops text such as prices and status messages, and a full
  // snapshot is verbose, so pair the interactive tree with the visible text.
  async snapshot(): Promise<Snapshot> {
    const [data, body, layout] = await Promise.all([
      this.run<{ origin: string; snapshot: string }>("snapshot", "-i"),
      this.run<{ text: string }>("get", "text", "body"),
      this.run<{ result: [number, number, number, boolean] }>("eval", LAYOUT_JS).then((r) => describeLayout(r.result), () => ""),
    ]);
    return { url: data.origin, text: data.snapshot, visibleText: body.text ?? "", layout, elements: parseSnapshot(data.snapshot) };
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.run("set", "viewport", String(width), String(height));
  }

  async title(): Promise<string> {
    return (await this.run<{ title: string }>("get", "title")).title ?? "";
  }

  async viewport(): Promise<{ width: number; height: number }> {
    const { result } = await this.run<{ result: [number, number] }>("eval", "[innerWidth, innerHeight]");
    return { width: result[0], height: result[1] };
  }

  async screenshot(path: string): Promise<string> {
    await this.run("screenshot", path, "--screenshot-format", "jpeg", "--screenshot-quality", "70");
    return path;
  }

  async clickAt(x: number, y: number): Promise<void> {
    await this.run("mouse", "move", String(Math.round(x)), String(Math.round(y)));
    await this.run("mouse", "down");
    await this.run("mouse", "up");
  }

  /** Best-effort wait for whatever the last action triggered to settle. */
  async settle(timeoutMs: number): Promise<void> {
    await Promise.race([this.run("wait", "--load", "domcontentloaded").catch(() => {}), Bun.sleep(timeoutMs)]);
  }
}

// `- textbox "Customer name:" [checked=false, ref=e2]: value`
const LINE = /^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(?:: (.*))?$/;

export function parseSnapshot(text: string): PageElement[] {
  const elements: PageElement[] = [];
  const stack: { indent: number; ref?: string }[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const attrs: Record<string, string | true> = {};
    for (const part of (m[4] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const eq = part.indexOf("=");
      if (eq === -1) attrs[part] = true;
      else attrs[part.slice(0, eq)] = part.slice(eq + 1);
    }
    const ref = typeof attrs.ref === "string" ? attrs.ref : undefined;
    const parent = [...stack].reverse().find((s) => s.ref)?.ref;
    if (ref) elements.push({ ref, role: m[2]!, name: (m[3] ?? "").replace(/\\"/g, '"'), value: m[5], attrs, parent });
    stack.push({ indent, ref });
  }
  return elements;
}
