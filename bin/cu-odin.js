#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "init";
const acceptDefaults = args.includes("--yes") || args.includes("-y");

if (args.includes("--help") || args.includes("-h") || cmd === "help") {
  printHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  const pkg = require(path.join(__dirname, "..", "package.json"));
  console.log(pkg.version);
  process.exit(0);
}

if (cmd !== "init") {
  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

const STACKS = ["nextjs", "react", "flutter", "python"];
const BACKENDS = ["supabase", "firebase"];

const STACK_ALIASES = {
  nextjs: "nextjs", "next.js": "nextjs", next: "nextjs", web: "nextjs", node: "nextjs", n: "nextjs",
  react: "react", spa: "react", "react-spa": "react", vite: "react", r: "react",
  flutter: "flutter", dart: "flutter", f: "flutter",
  python: "python", py: "python", p: "python", django: "python", fastapi: "python", flask: "python",
};
const BACKEND_ALIASES = {
  supabase: "supabase", postgres: "supabase", s: "supabase",
  firebase: "firebase", firestore: "firebase", fb: "firebase", f: "firebase",
};

const templateDir = path.join(__dirname, "..", "template");
const targetDir = process.cwd();

if (!fs.existsSync(templateDir)) {
  console.error(`Template directory not found: ${templateDir}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  console.log(`\ncu-odin: installing harness into ${targetDir}\n`);

  const detected = detectStack(targetDir);
  console.log(`  Detected stack: ${detected.stacks.length ? detected.stacks.join(" + ") : "none (no package.json or pubspec.yaml)"}.`);
  console.log(`  Detected backend: ${detected.backends.length ? detected.backends.join(" + ") : "none"}.\n`);

  const stacks = await promptStacks(detected.stacks);
  const backends = await promptBackends(detected.backends);
  console.log(`  Installing coders for: ${stacks.join(" + ")}; data agent for: ${backends.join(" + ")}\n`);

  // Categories the user gets to decide on, plus ticket assets which copy-if-missing
  // without prompting (versioned schema, no per-project edits).
  const groups = {
    claudeMd: {
      label: "CLAUDE.md",
      files: collectFiles((rel) => rel === "CLAUDE.md"),
    },
    agents: {
      label: ".claude/agents/",
      files: collectFiles((rel) =>
        rel.startsWith(path.join(".claude", "agents") + path.sep) &&
        agentForSelection(rel, stacks, backends)
      ),
    },
    domain: {
      label: ".claude/rules/domain.md",
      files: collectFiles((rel) => rel === path.join(".claude", "rules", "domain.md")),
    },
    designSystem: {
      label: ".claude/rules/design-system/",
      files: collectFiles((rel) =>
        rel.startsWith(path.join(".claude", "rules", "design-system") + path.sep)
      ),
    },
    rulesHarness: {
      // Vendored rules files referenced by CLAUDE.md / odin.md (ticket schema, harness
      // reuse instructions). Treated like agents: overwrite by default on re-install.
      label: ".claude/rules/ (vendored)",
      files: collectFiles((rel) => {
        const harnessRulesDir = path.join(".claude", "rules") + path.sep;
        if (!rel.startsWith(harnessRulesDir)) return false;
        if (rel === path.join(".claude", "rules", "domain.md")) return false;
        if (rel.startsWith(path.join(".claude", "rules", "design-system") + path.sep)) return false;
        return true;
      }),
    },
    tickets: {
      label: ".claude/assets/ticket-system/",
      files: collectFiles((rel) =>
        rel.startsWith(path.join(".claude", "assets", "ticket-system") + path.sep)
      ),
    },
    benchmarks: {
      label: ".claude/assets/benchmarks/",
      files: collectFiles((rel) =>
        rel.startsWith(path.join(".claude", "assets", "benchmarks") + path.sep)
      ),
    },
    skills: {
      label: ".claude/skills/",
      files: collectFiles((rel) =>
        rel.startsWith(path.join(".claude", "skills") + path.sep)
      ),
    },
  };

  const decisions = await promptDecisions(groups);

  const created = [];
  const overwritten = [];
  const skipped = [];

  applyGroup(groups.claudeMd, decisions.claudeMd, created, overwritten, skipped);
  applyGroup(groups.agents, decisions.agents, created, overwritten, skipped);
  applyGroup(groups.domain, decisions.domain, created, overwritten, skipped);
  applyGroup(groups.designSystem, decisions.designSystem, created, overwritten, skipped);
  applyGroup(groups.rulesHarness, decisions.rulesHarness, created, overwritten, skipped);
  applyGroup(groups.skills, decisions.skills, created, overwritten, skipped);
  applyGroup(groups.tickets, decisions.tickets, created, overwritten, skipped);
  applyGroup(groups.benchmarks, decisions.benchmarks, created, overwritten, skipped);

  const firestoreTickets = configureTicketTracker(backends, created);

  printSummary({ created, overwritten, skipped, backends, firestoreTickets });
}

// Firebase-only projects keep tickets in Firestore (via the Firebase MCP) so they don't
// need a Supabase project just for the tracker. Host-owned file: written once, never
// overwritten — delete it or set "backend": "supabase" to switch back.
function configureTicketTracker(backends, created) {
  const file = path.join(targetDir, ".claude", "ticket-tracker.json");
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).backend === "firebase";
    } catch {
      return false;
    }
  }
  if (!(backends.length === 1 && backends[0] === "firebase")) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let projectId = "<your-firebase-project-id>";
  try {
    projectId = JSON.parse(fs.readFileSync(path.join(targetDir, ".firebaserc"), "utf8")).projects?.default || projectId;
  } catch {
    // No .firebaserc yet — leave the placeholder for the user to fill in.
  }
  fs.writeFileSync(file, JSON.stringify({ backend: "firebase", projectId, collection: "odin_tickets" }, null, 2) + "\n");
  created.push(path.join(".claude", "ticket-tracker.json"));
  return true;
}

function collectFiles(filter) {
  const all = [];
  walk(templateDir, "");
  return all.filter(filter);

  function walk(root, rel) {
    const entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(root, childRel);
      else all.push(childRel);
    }
  }
}

// Best-effort detection from manifests and config files. Every result is only a
// default for the prompts below — the user (or --stack/--backend) has the final say.
function detectStack(dir) {
  const has = (rel) => fs.existsSync(path.join(dir, rel));
  const deps = readPackageDeps(path.join(dir, "package.json"));
  const pubspec = has("pubspec.yaml") ? fs.readFileSync(path.join(dir, "pubspec.yaml"), "utf8") : "";
  // Root manifests plus Firebase's Python functions dir (functions/main.py + requirements.txt).
  const pythonManifests = ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "uv.lock", "poetry.lock"]
    .flatMap((f) => [f, path.join("functions", f)]);
  // Concatenated Python manifests, scanned only for backend SDK names.
  const pyDeps = pythonManifests.filter(has).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");

  const stacks = [];
  if (deps) {
    // A package.json with neither next nor react is a plain Node project — coder-web covers it.
    if (deps.has("next") || !deps.has("react")) stacks.push("nextjs");
    else stacks.push("react");
  }
  if (pubspec) stacks.push("flutter");
  if (pythonManifests.some(has)) stacks.push("python");

  const backends = [];
  const firebaseFiles = ["firebase.json", ".firebaserc", "firestore.rules", "storage.rules", "database.rules.json"];
  const firebaseDeps = ["firebase", "firebase-admin", "reactfire", "@react-native-firebase/app"];
  if (
    firebaseFiles.some(has) ||
    (deps && firebaseDeps.some((d) => deps.has(d))) ||
    /^\s*(firebase_core|cloud_firestore|firebase_auth)\s*:/m.test(pubspec) ||
    /\bfirebase[-_](admin|functions)\b|\bgoogle-cloud-firestore\b/i.test(pyDeps)
  ) {
    backends.push("firebase");
  }
  if (
    has("supabase") ||
    (deps && [...deps].some((d) => d.startsWith("@supabase/"))) ||
    /^\s*supabase_flutter\s*:/m.test(pubspec) ||
    /^\s*["']?supabase\b/im.test(pyDeps)
  ) {
    backends.push("supabase");
  }

  return { stacks, backends };
}

function readPackageDeps(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
    ]);
  } catch {
    return new Set();
  }
}

// Filter agent files by the chosen stacks and backends. One coder per selected stack
// and one data agent per selected backend; everything else (odin, coder-elite,
// code-review*, security-review, ux-design) is stack-agnostic and always installs.
function agentForSelection(rel, stacks, backends) {
  const filename = path.basename(rel);
  if (filename === "coder-web.md") return stacks.includes("nextjs");
  if (filename === "coder-react.md") return stacks.includes("react");
  if (filename === "coder-flutter.md") return stacks.includes("flutter");
  if (filename === "coder-python.md") return stacks.includes("python");
  if (filename === "data-architect.md") return backends.includes("supabase");
  if (filename === "firebase-architect.md") return backends.includes("firebase");
  return true;
}

function flagValue(name) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("-") ? args[i + 1] : null;
}

// Parses "react, flutter" / "both" / aliases into a deduped list of canonical names.
// Returns null when nothing recognizable was given, so the caller falls back to the default.
function parseChoices(raw, aliases, allValue) {
  if (!raw) return null;
  const out = [];
  for (const token of raw.toLowerCase().split(/[\s,+/]+/).filter(Boolean)) {
    const mapped = token === "both" || token === "all" ? allValue : aliases[token];
    if (!mapped) continue;
    for (const m of [].concat(mapped)) if (!out.includes(m)) out.push(m);
  }
  return out.length ? out : null;
}

async function promptStacks(detected) {
  const def = detected.length ? detected : ["nextjs"];
  const fromFlag = parseChoices(flagValue("stack"), STACK_ALIASES, STACKS);
  if (fromFlag) {
    console.log(`  Stack: ${fromFlag.join(" + ")} (--stack)`);
    return fromFlag;
  }
  if (acceptDefaults || !process.stdin.isTTY) {
    console.log(`  Stack: ${def.join(" + ")} (default)`);
    return def;
  }
  const answer = await promptText(
    `  Which stack(s)? nextjs / react (SPA) / flutter / python — comma-separate for several (default: ${def.join(",")}) `
  );
  return parseChoices(answer, STACK_ALIASES, STACKS) || def;
}

async function promptBackends(detected) {
  const def = detected.length ? detected : ["supabase"];
  const fromFlag = parseChoices(flagValue("backend"), BACKEND_ALIASES, BACKENDS);
  if (fromFlag) {
    console.log(`  Backend: ${fromFlag.join(" + ")} (--backend)`);
    return fromFlag;
  }
  if (acceptDefaults || !process.stdin.isTTY) {
    console.log(`  Backend: ${def.join(" + ")} (default)`);
    return def;
  }
  const answer = await promptText(
    `  Which backend? supabase / firebase / both (default: ${def.join(",")}) `
  );
  return parseChoices(answer, BACKEND_ALIASES, BACKENDS) || def;
}

function promptText(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function groupExists(group) {
  return group.files.some((rel) => fs.existsSync(path.join(targetDir, rel)));
}

async function promptDecisions(groups) {
  const decisions = {};

  const claudeMdExists = groupExists(groups.claudeMd);
  decisions.claudeMd = await ask({
    label: groups.claudeMd.label,
    exists: claudeMdExists,
    questionExists: "Overwrite the existing CLAUDE.md with the latest from this cu-odin release?",
    questionMissing: "Install CLAUDE.md?",
    defaultIfExists: true,
    defaultIfMissing: true,
  });

  const agentsExists = groupExists(groups.agents);
  decisions.agents = await ask({
    label: groups.agents.label,
    exists: agentsExists,
    questionExists: "Overwrite the existing agents with the latest from this cu-odin release?",
    questionMissing: "Install agents?",
    defaultIfExists: true,
    defaultIfMissing: true,
  });

  const domainExists = groupExists(groups.domain);
  decisions.domain = await ask({
    label: groups.domain.label,
    exists: domainExists,
    questionExists: "Replace the existing domain.md with the placeholder stub? (this will lose your project brief)",
    questionMissing: "Stub in domain.md?",
    defaultIfExists: false,
    defaultIfMissing: true,
  });

  const dsExists = groupExists(groups.designSystem);
  decisions.designSystem = await ask({
    label: groups.designSystem.label,
    exists: dsExists,
    questionExists: "Replace the existing design-system/ with the placeholder stub? (this will overwrite your design system docs)",
    questionMissing: "Stub in design-system/?",
    defaultIfExists: false,
    defaultIfMissing: true,
  });

  const rulesHarnessExists = groupExists(groups.rulesHarness);
  decisions.rulesHarness = await ask({
    label: groups.rulesHarness.label,
    exists: rulesHarnessExists,
    questionExists: "Overwrite the vendored rules files (ticket-schema.md, harness-reuse.md) with the latest from this cu-odin release?",
    questionMissing: "Install vendored rules files (ticket-schema.md, harness-reuse.md)?",
    defaultIfExists: true,
    defaultIfMissing: true,
  });

  const benchmarksExists = groupExists(groups.benchmarks);
  decisions.benchmarks = await ask({
    label: groups.benchmarks.label,
    exists: benchmarksExists,
    questionExists: "Overwrite the benchmarks recipe with the latest from this cu-odin release?",
    questionMissing: "Install benchmarks recipe?",
    defaultIfExists: true,
    defaultIfMissing: true,
  });

  const ticketsExists = groupExists(groups.tickets);
  decisions.tickets = await ask({
    label: groups.tickets.label,
    exists: ticketsExists,
    questionExists: "Overwrite the existing ticket-system assets (including schema.sql) with the latest from this cu-odin release?",
    questionMissing: "Install ticket-system assets?",
    defaultIfExists: true,
    defaultIfMissing: true,
  });

  const skillsExists = groupExists(groups.skills);
  decisions.skills = await ask({
    label: groups.skills.label,
    exists: skillsExists,
    questionExists: "Overwrite the existing skills with the latest from this cu-odin release?",
    questionMissing: "Install skills?",
    defaultIfExists: true,
    defaultIfMissing: true,
  });

  return decisions;
}

async function ask({
  label,
  exists,
  questionExists,
  questionMissing,
  defaultIfExists,
  defaultIfMissing,
}) {
  const question = exists ? questionExists : questionMissing;
  const def = exists ? defaultIfExists : defaultIfMissing;

  if (acceptDefaults) {
    console.log(`  ${label}: ${def ? "yes" : "no"} (default)`);
    return def ? "overwrite" : "skip";
  }

  if (!process.stdin.isTTY) {
    // No TTY (piped/CI). Follow the same default as an interactive Enter:
    // overwrite/install when the default is yes, skip when it's no. This keeps
    // domain.md and design-system/ safe (default no on re-install) while letting
    // the versioned harness files refresh.
    return def ? (exists ? "overwrite" : "missing-only") : "skip";
  }

  const yes = await prompt(`  ${label}\n    ${question} [${def ? "Y/n" : "y/N"}] `);
  const answered = yes === null ? def : yes;
  return answered ? "overwrite" : "skip";
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") resolve(null); // use default
      else if (["y", "yes"].includes(trimmed)) resolve(true);
      else if (["n", "no"].includes(trimmed)) resolve(false);
      else resolve(null); // unrecognized — fall back to default
    });
  });
}

function applyGroup(group, mode, created, overwritten, skipped) {
  if (mode === "skip") {
    for (const rel of group.files) skipped.push(rel);
    return;
  }

  for (const rel of group.files) {
    const src = path.join(templateDir, rel);
    const dst = path.join(targetDir, rel);
    const exists = fs.existsSync(dst);

    if (mode === "missing-only" && exists) {
      skipped.push(rel);
      continue;
    }

    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    if (exists) overwritten.push(rel);
    else created.push(rel);
  }
}

function printSummary({ created, overwritten, skipped, backends, firestoreTickets }) {
  console.log("");
  if (created.length) {
    console.log(`Created (${created.length}):`);
    for (const f of created) console.log(`  + ${f}`);
  }
  if (overwritten.length) {
    console.log(`\nOverwritten (${overwritten.length}):`);
    for (const f of overwritten) console.log(`  ~ ${f}`);
  }
  if (skipped.length) {
    console.log(`\nSkipped (${skipped.length}):`);
    for (const f of skipped) console.log(`  · ${f}`);
  }

  console.log(`
Next steps:
  1. Edit .claude/rules/domain.md with your project's brief.
  2. Replace .claude/rules/design-system/* with your design system, or write
     it from scratch using the structure described in design-system/README.md.
  3. ${firestoreTickets
    ? `Tickets live in Firestore (.claude/ticket-tracker.json — check projectId).
     Add the Firebase MCP:  claude mcp add firebase -- npx -y firebase-tools@latest mcp
     sign in (firebase login), and add the rules block from
     .claude/rules/ticket-firestore.md to firestore.rules.`
    : `Apply .claude/assets/ticket-system/schema.sql to a Supabase project
     (see that folder's README).`}${backends.includes("firebase") ? `
  3b. Firebase: configure the Firebase MCP server (npx -y firebase-tools@latest mcp)
     in Claude Code so firebase-architect can introspect rules and data, and
     keep firestore.rules / storage.rules / firestore.indexes.json in the repo.` : ""}
  4. Open Claude Code in this repo. The orchestrator (odin) auto-loads via
     CLAUDE.md — invoke it for any non-trivial task.

Headless mode: include the word "headless" or "bifrost" in your request, or
let the harness signal "Auto mode active", to run unattended. The dispatcher
will not emit operational prompts in auto mode (the only exception is a dirty
working tree, which always prompts to commit/stash/abort).

Worktrees: every ticket runs in its own fresh git worktree off a
freshly-pulled base branch (opt out per ticket with --no-worktree; pick a
base with --branch <name>). On ship the dispatcher offers to merge into the
default branch; --auto-merge does it without asking (local only) and --push
pushes the default branch after merging.

Cohort orchestration: /process-ticket --orchestrate N runs N tickets in
parallel inside the same Claude session via Task-dispatched specialists,
each in its own git worktree. There are no separate claude CLI subprocesses.
`);
}

function printHelp() {
  console.log(`
cu-odin — Claude Code agent harness installer

Usage:
  npx -y github:mrsollis/cu-odin             Install harness into current directory (interactive)
  npx -y github:mrsollis/cu-odin init        Same as default
  npx -y github:mrsollis/cu-odin init --yes  Accept all defaults non-interactively
  npx -y github:mrsollis/cu-odin --stack react --backend firebase

Interactive prompts (Enter accepts the default):
  - Stack(s): nextjs / react / flutter / python (default: detected, else nextjs)
  - Backend: supabase / firebase / both      (default: detected, else supabase)
  - Overwrite agents + CLAUDE.md?            (default: yes)
  - Overwrite vendored rules / benchmarks?   (default: yes)
  - Overwrite .claude/skills/?               (default: yes)
  - Overwrite .claude/assets/ticket-system/? (default: yes)
  - Stub in .claude/rules/domain.md?         (default: no if it exists, yes if not)
  - Stub in .claude/rules/design-system/?    (default: no if it exists, yes if not)

Options:
  -y, --yes            Accept defaults non-interactively (safest in CI)
  --stack <list>       nextjs, react, flutter, python (comma-separated) — skips the stack prompt
  --backend <list>     supabase, firebase, or both — skips the backend prompt
  -h, --help           Show this help
  -v, --version        Print package version
`);
}
