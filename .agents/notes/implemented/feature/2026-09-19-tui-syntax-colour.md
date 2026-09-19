# Agent Note: Syntax colour for fenced code in the terminal

Status: implemented

English | [中文](2026-09-19-tui-syntax-colour.zh.md)

## Problem

A coding agent answers in code, and the terminal drew all of it in one colour. A fenced block reached the transcript as plain rows between two dim fences: a keyword, a string, a comment and an identifier were the same grey, so a reply had to be read word by word to find the line that mattered. The browser surface had shown the same code in colour since it shipped, from the shiki highlighter in `packages/client/ui-primitives`; only the terminal had none.

Nothing was missing from pi-tui. Its `Markdown` theme carries a `highlightCode(code, lang)` hook and falls back to plain rows when it is absent — which is what the terminal had always passed.

## Decision

`src/highlight.ts` fills that hook with a shiki core built for this surface.

**One highlighter family across surfaces.** The client already standardises on shiki with the JavaScript regex engine — no oniguruma WASM — and the terminal takes the same core rather than a second highlighter with second colours. It is a Host program, so it loads real theme modules instead of the client's CSS-variables theme.

**Nothing loads at start.** A grammar is a few hundred kilobytes of TextMate patterns and the first tokenisation of one compiles them. The map of grammars is one dynamic import each, the core itself is built on the first fence that resolves a language, and a session with no code in it loads none of it. The block that asked draws plain, the grammar is imported and warmed off the render path, and the application is told to build the frame again — `Markdown` caches its rendered lines, so the redraw invalidates the conversation first.

**The terminal's own background picks the theme.** The application already asks the terminal for its background colour to build the fade ramp; the same answer chooses `github-dark-default` or `github-light-default`, so a light terminal is not given dark-theme colours. A terminal that answers nothing takes the dark theme, which is what a terminal that answers nothing usually is.

**Colour depth is read on its own.** `resolveColorDepth` reads `COLORTERM` and `TERM` for 24-bit or 256 colours and nothing else: a user who asked for `reducedMotion` still gets coloured code, because colour is not motion. A terminal that claims neither depth, a disabled palette, `NO_COLOR`, and `codeHighlight: false` each draw every block plain.

**A fence never fails a frame.** Tokenising is third-party work over model-authored text running inside a render. A grammar that will not import, a module shape the loader cannot unwrap, a registration that lands under another name, and a tokeniser that throws each leave that language plain from then on. The id is trusted only once `getLoadedLanguages()` reports it.

## Alternatives considered

**Map shiki's scopes onto the nine palette roles.** Rejected: the palette is semantic — accent, success, warning, error — and syntax is not. Bucketing keywords, types, numbers and identifiers into three colours is most of the work for a fraction of the result, and the css-variables theme's own buckets put identifiers, types and numbers in one role. A theme distinguishes them because that is what a theme is for.

**Ship a fixed colour table of the sixteen ANSI colours instead of a theme.** Rejected as the default: terminal-native colours would follow the user's own scheme, but they also collapse a theme's distinctions and cannot express the two greys a comment and a border want. The depth check already refuses the terminals that cannot encode a theme, which is the case that rule was for.

**Load a small grammar set at start, as the client does for its boot languages.** Rejected: the client's boot set serves a document that is already open, while a terminal session's cost is measured from the key that launched it. Most sessions never render a fence, and the first one that does pays a redraw rather than every session paying a start.

**Highlight tool-card bodies — a written file, a read, a diff — as well.** Not done here: a card body is folded to a line budget and carries its own status glyphs and gutters, so it needs a decision of its own about what a partial block means. The fence in a reply is where a model's code is read.

**Let the block stay plain until the next render happens anyway.** Rejected: a reply that lands while the user watches would sit plain until an unrelated key was pressed. The highlighter asks for the frame itself, which is the same "draw what you have, correct it when it lands" the streamed fade and the subagent panel already use.

## Consequences

- `@deepseek-ai/dsh-tui-app` gains `shiki`, `@shikijs/langs` and `@shikijs/themes`. The bundle keeps the imports dynamic — `lib/index.js` grew by about 10 KB — so the grammars ship in the tarball but load from `node_modules` only when a fence asks.
- Seventeen languages are offered. A fence naming anything else draws plain, which is also what a bare fence does.
- `codeHighlight` joins the validated config as a boolean, default true.
- The first fenced block of a language is drawn twice: once plain, once in colour. On a transcript above the renderer's repaint window the second draw is not possible, and that block keeps the colours it had.

## Related decisions

The surface this draws into is [terminal surface as the shipped `tui` profile](../architecture/2026-09-15-terminal-surface-tui-app.md), and the blocks it colours are the ones [terminal reader overlay, Esc safety, and the editor as the hub](2026-09-18-tui-reader-overlay-and-esc-safety.md) folds and [the reader is two panels](../simplification/2026-09-18-tui-reader-two-panels.md) reads full screen. The client's own highlighter, whose grammar set and alias table this one follows, lives in `packages/client/ui-primitives/src/markdown/highlight.ts`.
