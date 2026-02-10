#!/usr/bin/env bun
/**
 * Postbuild script that patches the bundled findAmpCommand() from @sourcegraph/amp-sdk
 * to fallback to the system-installed `amp` CLI when the local @sourcegraph/amp package
 * cannot be resolved (which always happens when running as a compiled binary outside
 * the amp-acp project directory).
 */
import fs from 'node:fs';
import path from 'node:path';

const distFile = path.resolve(import.meta.dir, '../dist/index.js');

const original = `function findAmpCommand() {
  try {
    const require2 = createRequire(import.meta.url);
    const pkgJsonPath = require2.resolve("@sourcegraph/amp/package.json");
    const pkgJsonRaw = fs.readFileSync(pkgJsonPath, "utf8");
    const pkgJson = JSON.parse(pkgJsonRaw);
    if (pkgJson.bin?.amp) {
      const binPath = path.join(path.dirname(pkgJsonPath), pkgJson.bin.amp);
      return {
        command: "node",
        args: [binPath]
      };
    }
    throw new Error("Local @sourcegraph/amp package found but no bin entry for Amp CLI");
  } catch (error) {
    if (error instanceof Error && error.message.includes("Local @sourcegraph/amp")) {
      throw error;
    }
    throw new Error("Could not find local @sourcegraph/amp package. Make sure it is installed.");
  }
}`;

const patched = `function findAmpCommand() {
  try {
    const require2 = createRequire(import.meta.url);
    const pkgJsonPath = require2.resolve("@sourcegraph/amp/package.json");
    const pkgJsonRaw = fs.readFileSync(pkgJsonPath, "utf8");
    const pkgJson = JSON.parse(pkgJsonRaw);
    if (pkgJson.bin?.amp) {
      const binPath = path.join(path.dirname(pkgJsonPath), pkgJson.bin.amp);
      return {
        command: "node",
        args: [binPath]
      };
    }
    throw new Error("Local @sourcegraph/amp package found but no bin entry for Amp CLI");
  } catch (error) {
    if (error instanceof Error && error.message.includes("Local @sourcegraph/amp")) {
      throw error;
    }
    // Fallback: look for amp CLI in well-known locations and PATH
    const { execFileSync } = require("node:child_process");
    const os = require("node:os");
    const candidates = [];
    const homeDir = os.homedir();
    candidates.push(path.join(homeDir, ".amp", "bin", "amp"));
    if (process.platform === "win32") {
      candidates.push(path.join(homeDir, ".amp", "bin", "amp.exe"));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return { command: candidate, args: [] };
      }
    }
    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const result = execFileSync(whichCmd, ["amp"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (result) {
        return { command: result, args: [] };
      }
    } catch {}
    throw new Error("Could not find amp CLI. Install it from https://ampcode.com or ensure @sourcegraph/amp is available.");
  }
}`;

const content = fs.readFileSync(distFile, 'utf8');

if (!content.includes(original)) {
  console.error('Warning: Could not find the expected findAmpCommand() function to patch.');
  console.error('The @sourcegraph/amp-sdk version may have changed. Please update the patch script.');
  process.exit(1);
}

const patched_content = content.replace(original, patched);
fs.writeFileSync(distFile, patched_content);
console.error('Patched findAmpCommand() with system amp CLI fallback.');
