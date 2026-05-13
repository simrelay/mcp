#!/usr/bin/env node
// Cross-platform test runner: discovers test/*.test.ts and invokes the Node
// test runner with `tsx` registered. Replaces the shell glob in package.json
// which doesn't expand on Windows runners.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.dirname is Node 21.2+; derive it manually for Node 20.
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dir = join(root, "test");

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join(dir, f));

if (files.length === 0) {
  console.error(`No test files found in ${dir}`);
  process.exit(1);
}

const extra = process.argv.slice(2); // forward flags like --watch
const args = ["--import", "tsx", "--test", ...extra, ...files];

const result = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
