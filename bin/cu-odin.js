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

  // Three categories the user gets to decide on, plus ticket assets which
  // copy-if-missing without prompting (versioned schema, no per-project edits).
  const groups = {
    harness: {
      label: "agents + CLAUDE.md",
      files: collectFiles((rel) =>
        rel === "CLAUDE.md" || rel.startsWith(path.join(".claude", "agents") + path.sep)
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
  };

  const decisions = await promptDecisions(groups);

  const created = [];
  const overwritten = [];
  const skipped = [];

  applyGroup(groups.harness, decisions.harness, created, overwritten, skipped);
  applyGroup(groups.domain, decisions.domain, created, overwritten, skipped);
  applyGroup(groups.designSystem, decisions.designSystem, created, overwritten, skipped);
  // Tickets are always copy-if-missing, never overwrite, never prompted.
  applyGroup(groups.tickets, "missing-only", created, overwritten, skipped);

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

function groupExists(group) {
  return group.files.some((rel) => fs.existsSync(path.join(targetDir, rel)));
}

async function promptDecisions(groups) {
  const decisions = {};

  const harnessExists = groupExists(groups.harness);
  decisions.harness = await ask({
    label: groups.harness.label,
    exists: harnessExists,
    questionExists: "Overwrite the existing agents and CLAUDE.md with the latest from this cu-odin release?",
    questionMissing: "Install agents and CLAUDE.md?",
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

Headless mode: include the word "headless" or "bifrost" in your request to
skip the plan-approval gate. Quality, security, and ship gates remain.
`);
}

function printHelp() {
  console.log(`
cu-odin — Claude Code agent harness installer

Usage:
  npx cu-odin               Install harness into current directory (interactive)
  npx cu-odin init          Same as default
  npx cu-odin init --yes    Accept all defaults non-interactively

Interactive prompts:
  - Overwrite agents + CLAUDE.md?           (default: no if they exist, yes if not)
  - Stub in .claude/rules/domain.md?        (default: no if it exists, yes if not)
  - Stub in .claude/rules/design-system/?   (default: no if it exists, yes if not)

Always installed (no prompt):
  - .claude/assets/ticket-system/  copy-if-missing, never overwrites your edits

Options:
  -y, --yes        Accept defaults non-interactively (safest in CI)
  -h, --help       Show this help
  -v, --version    Print package version
`);
}
