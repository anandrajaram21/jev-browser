// Compile jev-browser into standalone binaries (no Bun or checkout needed to
// run them) plus the release extras: SHA256SUMS, a Homebrew formula and npm
// packages that pick the right binary per platform.
//
//   bun scripts/build.ts            all targets
//   bun scripts/build.ts --current  only this machine's target (quick local check)
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";
import plugin from "../.claude-plugin/plugin.json";

const REPO = "anandrajaram21/jev-browser";
// `jev-browser` on npm belongs to someone else, so the npm packages are scoped.
const NPM_SCOPE = process.env.NPM_SCOPE ?? "@anandrajaram21";
const DIST = join(import.meta.dir, "..", "dist");

const TARGETS = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "windows", arch: "x64" },
] as const;
type Target = (typeof TARGETS)[number];

const hostOs = process.platform === "win32" ? "windows" : process.platform;
const asset = (t: Target) => `jev-browser-${t.os}-${t.arch}${t.os === "windows" ? ".exe" : ""}`;
const tag = `v${pkg.version}`;

if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== tag) {
  throw new Error(`tag ${process.env.RELEASE_TAG} doesn't match package.json version ${pkg.version}`);
}

if (plugin.version !== pkg.version) {
  throw new Error(`.claude-plugin/plugin.json version ${plugin.version} doesn't match package.json ${pkg.version}`);
}

const current = process.argv.includes("--current");
const targets = current ? TARGETS.filter((t) => t.os === hostOs && t.arch === process.arch) : TARGETS;
if (!targets.length) throw new Error(`no build target for ${hostOs}-${process.arch}`);

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const sums: Record<string, string> = {};
for (const t of targets) {
  const out = join(DIST, asset(t));
  await Bun.$`bun build ${join(import.meta.dir, "..", "src", "cli.ts")} --compile --minify --target=bun-${t.os}-${t.arch} --outfile ${out}`.quiet();
  sums[asset(t)] = new Bun.CryptoHasher("sha256").update(await Bun.file(out).arrayBuffer()).digest("hex");
  console.log(`built ${asset(t)}`);
}
await Bun.write(join(DIST, "SHA256SUMS"), Object.entries(sums).map(([f, h]) => `${h}  ${f}\n`).join(""));
if (current) process.exit(0);

// Homebrew formula: installs the prebuilt binary; agent-browser comes along as a dependency.
const url = (t: Target) => `https://github.com/${REPO}/releases/download/${tag}/${asset(t)}`;
const brewBlock = (os: "darwin" | "linux") =>
  TARGETS.filter((t) => t.os === os)
    .map((t) => `    on_${t.arch === "arm64" ? "arm" : "intel"} do
      url "${url(t)}"
      sha256 "${sums[asset(t)]}"
    end`)
    .join("\n");
await Bun.write(
  join(DIST, "homebrew", "jev-browser.rb"),
  `class JevBrowser < Formula
  desc "${pkg.description}"
  homepage "https://github.com/${REPO}"
  version "${pkg.version}"

  on_macos do
${brewBlock("darwin")}
  end
  on_linux do
${brewBlock("linux")}
  end

  depends_on "agent-browser"

  def install
    bin.install Dir["jev-browser-*"].first => "jev-browser"
  end

  def caveats
    <<~EOS
      Download Chrome for agent-browser (once):  agent-browser install
      Save your API keys:                        jev-browser setup
      Teach your coding agents about it:         jev-browser install-skill
      Check everything:                          jev-browser doctor
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/jev-browser --version")
  end
end
`,
);

// npm: one package per platform holding its binary, and a main package whose
// launcher runs whichever one npm installed (esbuild's layout).
const npmDir = join(DIST, "npm");
const npmName = (t: Target) => `${NPM_SCOPE}/jev-browser-${t.os}-${t.arch}`;
const common = { version: pkg.version, license: "UNLICENSED", repository: { type: "git", url: `git+https://github.com/${REPO}.git` } };
for (const t of TARGETS) {
  const dir = join(npmDir, `jev-browser-${t.os}-${t.arch}`);
  const bin = `jev-browser${t.os === "windows" ? ".exe" : ""}`;
  await Bun.write(join(dir, bin), Bun.file(join(DIST, asset(t))));
  chmodSync(join(dir, bin), 0o755);
  await Bun.write(
    join(dir, "package.json"),
    JSON.stringify({ name: npmName(t), ...common, description: `jev-browser binary for ${t.os}-${t.arch}`, os: [t.os === "windows" ? "win32" : t.os], cpu: [t.arch], files: [bin] }, null, 2),
  );
}
const main = join(npmDir, "jev-browser");
await Bun.write(
  join(main, "package.json"),
  JSON.stringify(
    {
      name: `${NPM_SCOPE}/jev-browser`,
      ...common,
      description: pkg.description,
      bin: { "jev-browser": "bin/jev-browser.js" },
      files: ["bin", "README.md"],
      optionalDependencies: Object.fromEntries(TARGETS.map((t) => [npmName(t), pkg.version])),
    },
    null,
    2,
  ),
);
await Bun.write(join(main, "README.md"), Bun.file(join(import.meta.dir, "..", "README.md")));
await Bun.write(
  join(main, "bin", "jev-browser.js"),
  `#!/usr/bin/env node
// Runs the prebuilt binary from the platform package npm installed alongside this one.
const { spawnSync } = require("node:child_process");
const os = process.platform === "win32" ? "windows" : process.platform;
const pkg = "${NPM_SCOPE}/jev-browser-" + os + "-" + process.arch;
let bin;
try {
  bin = require.resolve(pkg + "/jev-browser" + (os === "windows" ? ".exe" : ""));
} catch {
  console.error("jev-browser: no prebuilt binary for " + os + "-" + process.arch + " (" + pkg + " is not installed).\\n" +
    "Reinstall without --no-optional, or see https://github.com/${REPO}#install");
  process.exit(1);
}
const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (r.error) {
  console.error("jev-browser: " + r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
`,
);
chmodSync(join(main, "bin", "jev-browser.js"), 0o755);
console.log(`wrote SHA256SUMS, homebrew/jev-browser.rb and npm packages for ${tag}`);
