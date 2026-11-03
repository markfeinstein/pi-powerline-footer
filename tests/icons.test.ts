import { test } from "node:test";
import assert from "node:assert/strict";
import { hasNerdFonts, NERD_ICONS, setNerdFontsPreference } from "../icons.ts";

test("context and cache use distinct Nerd Font symbols", () => {
  assert.equal(NERD_ICONS.context, "\u{F035B}");
  assert.equal(NERD_ICONS.cache, "\u{F00E8}");
  assert.equal(NERD_ICONS.auto, "\u{F0615}");
  assert.equal(NERD_ICONS.thinking, "\u{F09D1}");
  assert.notEqual(NERD_ICONS.context, NERD_ICONS.cache);
});

test("hasNerdFonts uses TERM only when TERM_PROGRAM is unset and preserves overrides", () => {
  const saved = { ...process.env };
  try {
    setNerdFontsPreference(null);
    delete process.env.TERM_PROGRAM;
    delete process.env.POWERLINE_NERD_FONTS;
    delete process.env.GHOSTTY_RESOURCES_DIR;

    process.env.TERM = "xterm-kitty";
    assert.equal(hasNerdFonts(), true, "kitty TERM=xterm-kitty should be detected");

    process.env.TERM = "xterm-256color";
    assert.equal(hasNerdFonts(), false, "plain xterm should not be detected");

    process.env.TERM = "xterm-kitty";
    process.env.TERM_PROGRAM = "vscode";
    assert.equal(hasNerdFonts(), false, "TERM must not override a present TERM_PROGRAM");

    process.env.TERM_PROGRAM = "";
    assert.equal(hasNerdFonts(), false, "empty TERM_PROGRAM must not fall back to TERM");

    process.env.TERM = "xterm-256color";
    process.env.TERM_PROGRAM = "WezTerm";
    assert.equal(hasNerdFonts(), true, "recognized TERM_PROGRAM remains case-insensitive");

    process.env.TERM_PROGRAM = "Kaku";
    assert.equal(hasNerdFonts(), true, "Kaku TERM_PROGRAM should be detected");

    process.env.TERM_PROGRAM = "vscode";
    process.env.POWERLINE_NERD_FONTS = "1";
    assert.equal(hasNerdFonts(), true, "explicit enable overrides the terminal heuristic");

    delete process.env.POWERLINE_NERD_FONTS;
    process.env.GHOSTTY_RESOURCES_DIR = "/ghostty";
    assert.equal(hasNerdFonts(), true, "Ghostty marker overrides the terminal heuristic");

    process.env.POWERLINE_NERD_FONTS = "0";
    assert.equal(hasNerdFonts(), false, "explicit disable overrides Ghostty");
  } finally {
    setNerdFontsPreference(null);
    for (const key of ["TERM", "TERM_PROGRAM", "POWERLINE_NERD_FONTS", "GHOSTTY_RESOURCES_DIR"]) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
});

test("powerline nerdFonts setting overrides terminal heuristics but not the environment", () => {
  const saved = { ...process.env };
  try {
    delete process.env.POWERLINE_NERD_FONTS;
    delete process.env.GHOSTTY_RESOURCES_DIR;
    process.env.TERM_PROGRAM = "vscode";
    process.env.TERM = "xterm-256color";

    setNerdFontsPreference(true);
    assert.equal(hasNerdFonts(), true);

    setNerdFontsPreference(false);
    assert.equal(hasNerdFonts(), false);

    process.env.POWERLINE_NERD_FONTS = "1";
    assert.equal(hasNerdFonts(), true);

    process.env.POWERLINE_NERD_FONTS = "0";
    setNerdFontsPreference(true);
    assert.equal(hasNerdFonts(), false);
  } finally {
    setNerdFontsPreference(null);
    for (const key of ["TERM", "TERM_PROGRAM", "POWERLINE_NERD_FONTS", "GHOSTTY_RESOURCES_DIR"]) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
});
