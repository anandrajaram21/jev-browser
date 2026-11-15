// `jev-browser update`: replace the running binary with the latest GitHub release.
// Homebrew, npm and source installs are left to their own tools, since swapping
// the binary under them would leave the package manager's records stale.
import { chmodSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../package.json";

const REPO = "anandrajaram21/jev-browser";
const NPM_PACKAGE = "@anandrajaram21/jev-browser";

export type InstallKind = "binary" | "homebrew" | "npm" | "source";

/** How this copy was installed, from whether it's compiled and where the executable lives. */
export function installKind(compiled: boolean, execPath: string): InstallKind {
  if (!compiled) return "source";
  const path = execPath.replaceAll("\\", "/");
  if (path.includes("/node_modules/")) return "npm";
  if (path.includes("/Cellar/") || path.includes("/homebrew/") || path.includes("/linuxbrew/")) return "homebrew";
  return "binary";
}

/** Release asset for a platform; matches install.sh and scripts/build.ts. */
export function assetName(platform: string, arch: string, rosetta = false): string {
  const os = platform === "win32" ? "windows" : platform;
  // An x64 binary under Rosetta upgrades to the native Apple silicon one.
  const cpu = os === "darwin" && arch === "x64" && rosetta ? "arm64" : arch;
  return `jev-browser-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

/** The hash SHA256SUMS lists for an asset. */
export function checksumFor(sums: string, asset: string): string | undefined {
  for (const line of sums.split("\n")) {
    const [hash, file] = line.trim().split(/\s+/);
    if (file === asset) return hash;
  }
}

/** Compare dotted versions ("0.10.0" > "0.9.1"); a leading "v" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// /releases/latest redirects to /releases/tag/<tag>; reading the redirect
// avoids the API's unauthenticated rate limit.
async function latestTag(): Promise<string> {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual" });
  const tag = res.headers.get("location")?.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
  if (!tag) throw new Error(`couldn't find the latest release (HTTP ${res.status} from github.com)`);
  return decodeURIComponent(tag);
}

async function download(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`);
  return res;
}

const isRosetta = () =>
  process.platform === "darwin" && Bun.spawnSync(["sysctl", "-n", "sysctl.proc_translated"]).stdout.toString().trim() === "1";

/** Update to the latest release, or to `version` (e.g. "0.2.0" or "v0.2.0"). */
export async function update(version?: string) {
  // Compiled binaries run from Bun's embedded filesystem.
  const compiled = import.meta.path.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/i.test(import.meta.path);
  const exe = realpathSync(process.execPath);
  const kind = installKind(compiled, exe);
  if (kind === "source") return console.log("Running from a source checkout; update it with: git pull && bun install");
  if (kind === "homebrew") return console.log("Installed with Homebrew; update it with: brew upgrade jev-browser");
  if (kind === "npm") return console.log(`Installed with npm; update it with: npm i -g ${NPM_PACKAGE}@latest`);

  const tag = version ? `v${version.replace(/^v/, "")}` : await latestTag();
  if (!version && compareVersions(tag, pkg.version) <= 0) return console.log(`jev-browser ${pkg.version} is up to date`);

  const asset = assetName(process.platform, process.arch, isRosetta());
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  console.log(`Downloading ${asset} (${tag})...`);
  const [binary, sums] = await Promise.all([
    download(`${base}/${asset}`).then((r) => r.arrayBuffer()),
    download(`${base}/SHA256SUMS`).then((r) => r.text()),
  ]);
  const expected = checksumFor(sums, asset);
  const actual = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${asset}; nothing was changed`);

  // Write next to the executable so the final rename stays on one filesystem.
  const next = join(dirname(exe), `.jev-browser-${tag}.tmp`);
  try {
    writeFileSync(next, new Uint8Array(binary), { mode: 0o755 });
    chmodSync(next, 0o755);
    // Windows can't overwrite a running .exe, but it can rename it out of the way.
    if (process.platform === "win32") {
      rmSync(`${exe}.old`, { force: true });
      renameSync(exe, `${exe}.old`);
    }
    renameSync(next, exe);
  } catch (err) {
    rmSync(next, { force: true });
    if ((err as NodeJS.ErrnoException).code === "EACCES" || (err as NodeJS.ErrnoException).code === "EPERM") {
      throw new Error(`no permission to replace ${exe}; rerun with sudo, or reinstall with install.sh`);
    }
    throw err;
  }

  const installed = Bun.spawnSync([exe, "--version"]).stdout.toString().trim();
  console.log(`Updated ${exe}: ${pkg.version} -> ${installed || tag}`);
  console.log("Run jev-browser install-skill to bring your agents' skill up to date too.");
}
