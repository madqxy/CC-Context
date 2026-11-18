#!/usr/bin/env node
// typecheck runs tsc over the code the engine loads (hooks/ and src/).
//
// The compiler options normally come from .claude-plugin/types/tsconfig.json,
// which the engine writes on its first load of this folder and which is
// gitignored. A fresh checkout therefore has neither that file nor the module
// declarations for "claude-code", and a plain `tsc -p .` fails with TS5083
// before it checks anything.
//
// This wrapper keeps the real path when the engine has run, and otherwise writes
// an equivalent local config plus a stub for "claude-code" so the check still
// covers this repo's own code. Under the stub, `$` and `on` are `any`: engine
// members are not checked, everything else is.
//
//   npm run typecheck
//   TSC=/path/to/tsc npm run typecheck     # a specific compiler

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Quiet by default: the fallback is the normal path on a fresh checkout, so its
// note would print on every run. `--verbose` says which mode was used.
const VERBOSE = process.argv.includes("--verbose");
const ENGINE_CONFIG = path.join(ROOT, ".claude-plugin", "types", "tsconfig.json");
const FALLBACK_CONFIG = path.join(ROOT, ".tsconfig.fallback.json");
const FALLBACK_STUB = path.join(ROOT, ".typecheck-stub.d.ts");

const STUB = `// Written by scripts/typecheck.mjs when the engine has not generated its own
// types yet. Only used by .tsconfig.fallback.json, and removed afterwards.
declare module "claude-code" {
  export type EngineInterface = any;
  export type On = any;
}
`;

const FALLBACK = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    lib: ["ES2022"],
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    strict: false,
    noImplicitAny: false,
    noUncheckedIndexedAccess: false,
  },
  include: ["hooks/**/*.mjs", "src/**/*.mjs", ".typecheck-stub.d.ts"],
};

function resolveTsc() {
  const fromEnv = process.env.TSC;
  if (fromEnv) {
    return fs.existsSync(fromEnv) ? fromEnv : null;
  }
  const local = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (fs.existsSync(local)) {
    return local;
  }
  const probe = spawnSync("tsc", ["--version"], { encoding: "utf8", shell: true });
  return probe.status === 0 ? "tsc" : null;
}

function run(tsc, configPath) {
  // The typescript package ships an extensionless JS file at bin/tsc; only a
  // .cmd/.exe (or a bare name resolved from PATH) is a real executable.
  const isScript = fs.existsSync(tsc) && !/\.(cmd|exe|bat)$/i.test(tsc);
  const args = isScript ? [tsc, "-p", configPath] : ["-p", configPath];
  const command = isScript ? process.execPath : tsc;
  return spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: !isScript });
}

const tsc = resolveTsc();
if (!tsc) {
  console.error("typecheck: no tsc found. Install it once with `npm i -D typescript`, or set TSC.");
  process.exit(1);
}

const hasEngineTypes = fs.existsSync(ENGINE_CONFIG);
let status = 1;

try {
  if (hasEngineTypes) {
    status = run(tsc, ROOT).status ?? 1;
  } else {
    if (VERBOSE) {
      console.log("typecheck: .claude-plugin/types/ is missing (the engine writes it on first load)");
      console.log("typecheck: using a local fallback with a stub for \"claude-code\"; run `claude plugin test .` for the real one");
    }
    fs.writeFileSync(FALLBACK_CONFIG, JSON.stringify(FALLBACK, null, 2) + "\n", "utf8");
    fs.writeFileSync(FALLBACK_STUB, STUB, "utf8");
    status = run(tsc, FALLBACK_CONFIG).status ?? 1;
  }
} finally {
  for (const file of [FALLBACK_CONFIG, FALLBACK_STUB]) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      // Not there, or already gone.
    }
  }
}

process.exit(status);
