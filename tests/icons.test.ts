import test from "node:test";
import assert from "node:assert/strict";
import {
  ASCII_SEPARATORS,
  NERD_SEPARATORS,
  getSeparatorChars,
  hasNerdFonts,
  setNerdFontsPreference,
} from "../icons.ts";
import { parsePowerlineConfig } from "../powerline-config.ts";

const PRESETS = ["default", "full", "custom"] as const;

function withNerdFontsEnv(value: string | undefined, fn: () => void): void {
  const original = process.env.POWERLINE_NERD_FONTS;
  if (value === undefined) {
    delete process.env.POWERLINE_NERD_FONTS;
  } else {
    process.env.POWERLINE_NERD_FONTS = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.POWERLINE_NERD_FONTS;
    } else {
      process.env.POWERLINE_NERD_FONTS = original;
    }
  }
}

function withNerdFontsConfig(value: boolean | null, fn: () => void): void {
  try {
    setNerdFontsPreference(value);
    fn();
  } finally {
    setNerdFontsPreference(null);
  }
}

test("hasNerdFonts defaults to true when the env var is unset", () => {
  withNerdFontsEnv(undefined, () => {
    assert.equal(hasNerdFonts(), true);
  });
});

test("hasNerdFonts honors POWERLINE_NERD_FONTS=1", () => {
  withNerdFontsEnv("1", () => {
    assert.equal(hasNerdFonts(), true);
  });
});

test("hasNerdFonts honors documented POWERLINE_NERD_FONTS=0 opt-out", () => {
  withNerdFontsEnv("0", () => {
    assert.equal(hasNerdFonts(), false);
  });
});

test("getSeparatorChars selects the ASCII set when Nerd Fonts are disabled", () => {
  withNerdFontsEnv("0", () => {
    assert.deepEqual(getSeparatorChars(), ASCII_SEPARATORS);
  });
  withNerdFontsEnv("1", () => {
    assert.deepEqual(getSeparatorChars(), NERD_SEPARATORS);
  });
});

test("hasNerdFonts uses the config preference when the env var is unset", () => {
  withNerdFontsEnv(undefined, () => {
    withNerdFontsConfig(false, () => {
      assert.equal(hasNerdFonts(), false);
    });
    withNerdFontsConfig(true, () => {
      assert.equal(hasNerdFonts(), true);
    });
  });
});

test("hasNerdFonts falls back to the default when neither env nor config is set", () => {
  withNerdFontsEnv(undefined, () => {
    withNerdFontsConfig(null, () => {
      assert.equal(hasNerdFonts(), true);
    });
  });
});

test("POWERLINE_NERD_FONTS env var overrides the config preference", () => {
  // Env on beats config off.
  withNerdFontsEnv("1", () => {
    withNerdFontsConfig(false, () => {
      assert.equal(hasNerdFonts(), true);
    });
  });
  // Env off beats config on.
  withNerdFontsEnv("0", () => {
    withNerdFontsConfig(true, () => {
      assert.equal(hasNerdFonts(), false);
    });
  });
});

test("parsePowerlineConfig reads the nerdFonts preference", () => {
  assert.equal(parsePowerlineConfig({ nerdFonts: true }, PRESETS).nerdFonts, true);
  assert.equal(parsePowerlineConfig({ nerdFonts: false }, PRESETS).nerdFonts, false);
  // Unset or non-boolean leaves it null (fall back to env var, then default).
  assert.equal(parsePowerlineConfig({}, PRESETS).nerdFonts, null);
  assert.equal(parsePowerlineConfig({ nerdFonts: "yes" }, PRESETS).nerdFonts, null);
});
