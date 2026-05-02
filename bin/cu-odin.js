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

  const stack = detectStack(targetDir);
  if (stack.web && stack.flutter) {
    console.log(`  Detected stack: fullstack (web + flutter) — installing both coder agents.\n`);
  } else if (stack.web) {
    console.log(`  Detected stack: web (package.json present) — installing coder-web only.\n`);
  } else if (stack.flutter) {
    console.log(`  Detected stack: flutter (pubspec.yaml present) — installing coder-flutter only.\n`);
  } else {
    console.log(`  No stack detected (no package.json or pubspec.yaml). Installing both coders so you can choose later.\n`);
  }

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
        agentForStack(rel, stack)
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
    tickets: {
      label: ".claude/assets/ticket-system/",
      files: collectFiles((rel) =>
        rel.startsWith(path.join(".claude", "assets", "ticket-system") + path.sep)
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
  applyGroup(groups.skills, decisions.skills, created, overwritten, skipped);
  applyGroup(groups.tickets, decisions.tickets, created, overwritten, skipped);

  printSummary({ created, overwritten, skipped });
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

function detectStack(dir) {
  return {
    web: fs.existsSync(path.join(dir, "package.json")),
    flutter: fs.existsSync(path.join(dir, "pubspec.yaml")),
  };
}

// Filter agent files by detected stack. Web-only repos skip coder-flutter; Flutter-only
// repos skip coder-web. Repos with neither (or both) get the full set so the user can
// pick later. coder-elite, the *-elite agents, and stack-agnostic agents (tdd, ux-design,
// data-architect, security-review, code-review, odin) always install.
function agentForStack(rel, stack) {
  const fullstackOrUnknown = (stack.web && stack.flutter) || (!stack.web && !stack.flutter);
  if (fullstackOrUnknown) return true;

  const filename = path.basename(rel);
  if (filename === "coder-web.md") return stack.web === true;
  if (filename === "coder-flutter.md") return stack.flutter === true;
  return true;
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
    defaultIfExists: false,
    defaultIfMissing: true,
  });

  const agentsExists = groupExists(groups.agents);
  decisions.agents = await ask({
    label: groups.agents.label,
    exists: agentsExists,
    questionExists: "Overwrite the existing agents with the latest from this cu-odin release?",
    questionMissing: "Install agents?",
    defaultIfExists: false,
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

  const ticketsExists = groupExists(groups.tickets);
  decisions.tickets = await ask({
    label: groups.tickets.label,
    exists: ticketsExists,
    questionExists: "Overwrite the existing ticket-system assets (including schema.sql) with the latest from this cu-odin release?",
    questionMissing: "Install ticket-system assets?",
    defaultIfExists: false,
    defaultIfMissing: true,
  });

  const skillsExists = groupExists(groups.skills);
  decisions.skills = await ask({
    label: groups.skills.label,
    exists: skillsExists,
    questionExists: "Overwrite the existing skills with the latest from this cu-odin release?",
    questionMissing: "Install skills?",
    defaultIfExists: false,
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
    // No TTY (piped/CI). Use safest behavior: install if missing, skip if exists.
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

function printSummary({ created, overwritten, skipped }) {
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
  3. Apply .claude/assets/ticket-system/schema.sql to your Supabase project,
     then seed the suggestions ledger ticket (see that folder's README).
  4. Open Claude Code in this repo. The orchestrator (odin) auto-loads via
     CLAUDE.md — invoke it for any non-trivial task.

Headless mode: include the word "headless" or "bifrost" in your request, or
let the harness signal "Auto mode active", to run unattended. The dispatcher
will not emit operational prompts in auto mode (the only exception is a dirty
working tree, which always prompts to commit/stash/abort).

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

Interactive prompts:
  - Overwrite agents + CLAUDE.md?           (default: no if they exist, yes if not)
  - Stub in .claude/rules/domain.md?        (default: no if it exists, yes if not)
  - Stub in .claude/rules/design-system/?   (default: no if it exists, yes if not)
  - Overwrite .claude/skills/?              (default: no if they exist, yes if not)
  - Overwrite .claude/assets/ticket-system/?(default: no if they exist, yes if not)

Options:
  -y, --yes        Accept defaults non-interactively (safest in CI)
  -h, --help       Show this help
  -v, --version    Print package version
`);
}
