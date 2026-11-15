import { expect, test } from "bun:test";
import { assetName, checksumFor, compareVersions, installKind } from "./update.ts";

test("installKind tells release binaries from Homebrew, npm and source installs", () => {
  expect(installKind(false, "/opt/homebrew/bin/bun")).toBe("source");
  expect(installKind(true, "/Users/a/.local/bin/jev-browser")).toBe("binary");
  expect(installKind(true, "/opt/homebrew/Cellar/jev-browser/0.1.0/bin/jev-browser")).toBe("homebrew");
  expect(installKind(true, "/home/linuxbrew/.linuxbrew/Cellar/jev-browser/0.1.0/bin/jev-browser")).toBe("homebrew");
  expect(installKind(true, "/usr/lib/node_modules/@anandrajaram21/jev-browser-linux-x64/jev-browser")).toBe("npm");
  expect(installKind(true, "C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@x\\jev-browser.exe")).toBe("npm");
});

test("assetName matches the release assets", () => {
  expect(assetName("darwin", "arm64")).toBe("jev-browser-darwin-arm64");
  expect(assetName("darwin", "x64", true)).toBe("jev-browser-darwin-arm64");
  expect(assetName("linux", "x64", true)).toBe("jev-browser-linux-x64");
  expect(assetName("win32", "x64")).toBe("jev-browser-windows-x64.exe");
});

test("checksumFor reads SHA256SUMS lines", () => {
  const sums = "aaa  jev-browser-darwin-arm64\nbbb  jev-browser-darwin-arm64.exe\n";
  expect(checksumFor(sums, "jev-browser-darwin-arm64")).toBe("aaa");
  expect(checksumFor(sums, "jev-browser-linux-x64")).toBeUndefined();
});

test("compareVersions compares numerically and ignores a leading v", () => {
  expect(compareVersions("v0.10.0", "0.9.1")).toBe(1);
  expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
  expect(compareVersions("0.1", "0.1.1")).toBe(-1);
});
