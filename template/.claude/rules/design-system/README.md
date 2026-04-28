# Design system

> **Replace this folder's contents** with your project's design system. The `ux-design` agent reads every file here before producing a spec; the `coder-*` agents read it before implementing UI.

## Convention

The agents look for:

- A `README.md` in this folder (this file) — design philosophy + an index of the other files
- One topic per file, prefixed with a number for ordering. The agents read in numeric order.

A good baseline structure:

```
00-principles.md           # core design principles, the "vibe" checklist
01-color.md                # palette, semantic tokens, theming (light/dark)
02-typography.md           # fonts, type scale, casing
03-numerics.md             # if your product is data-heavy: tabular figures, deltas, abbreviations
04-spacing-layout.md       # spacing scale, radii, app layout
05-borders-shadows.md      # borders, elevation tokens
06-motion.md               # easing, durations, hover/press
07-iconography.md          # icon set, sizing, brand glyph
08-voice-content.md        # voice, casing, copy rules
09-imagery-backgrounds.md  # imagery treatment, background rules
10-components.md           # default recipes for buttons, inputs, cards, tables, etc.
```

You don't have to use every file or this exact numbering — just keep one topic per file with consistent prefixes so the agents can read in a predictable order.

## What to put in each file

Each file should:

1. **State the rule, then the reasoning.** "Headlines use sentence case" + "because the product reads like an analyst's notebook, not marketing copy."
2. **Use semantic tokens, not raw values.** Define `--brand`, `--bg-1`, `--space-4` once and reference them everywhere. Never hardcode `#1f7c74` or `16px` inside a component spec.
3. **Be enforceable.** "No 16px+ radii" is enforceable. "Feel premium" is not. Both are useful, but the rules that block reviews need to be specific.

## Source of truth

Markdown rule files are the source of truth. If you ship a `tokens.css` or `tokens.json` alongside, treat it as a generated artifact derived from the rule files.
