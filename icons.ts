import { loadThemeConfig } from "./theme.ts";

export interface IconSet {
  pi: string;
  model: string;
  folder: string;
  branch: string;
  git: string;
  tokens: string;
  context: string;
  thinking: string;
  cost: string;
  time: string;
  agents: string;
  cache: string;
  input: string;
  output: string;
  host: string;
  session: string;
  auto: string;
  warning: string;
}

// Separator characters
export const SEP_DOT = " · ";

// Thinking level display text (Unicode/ASCII)
export const THINKING_TEXT_UNICODE: Record<string, string> = {
  minimal: "[min]",
  low: "[low]",
  medium: "[med]",
  high: "[high]",
  xhigh: "[xhi]",
};

// Thinking level display text (Nerd Fonts - with icons)
export const THINKING_TEXT_NERD: Record<string, string> = {
  minimal: "\u{F0E7} min",   // lightning bolt
  low: "\u{F10C} low",       // circle outline
  medium: "\u{F192} med",    // dot circle
  high: "\u{F111} high",     // circle
  xhigh: "\u{F06D} xhi",     // fire
};

// Get thinking text based on font support
export function getThinkingText(level: string): string | undefined {
  if (hasNerdFonts()) {
    return THINKING_TEXT_NERD[level];
  }
  return THINKING_TEXT_UNICODE[level];
}

// Nerd Font icons (matching oh-my-pi exactly)
export const NERD_ICONS: IconSet = {
  pi: "\uE22C",         // nf-oct-pi (stylized pi icon)
  model: "\uEC19",      // nf-md-chip (model/AI chip)
  folder: "\uF115",     // nf-fa-folder_open
  branch: "\uF126",     // nf-fa-code_fork (git branch)
  git: "\uF1D3",        // nf-fa-git (git logo)
  tokens: "\uE26B",     // nf-seti-html (tokens symbol)
  context: "\u{F0029}",  // nf-md-gauge (context usage gauge)
  thinking: "",          // no icon for thinking level
  cost: "\uF09D",       // nf-fa-credit_card
  time: "\uF017",       // nf-fa-clock_o
  agents: "\uF0C0",     // nf-fa-users
  cache: "\uF1C0",      // nf-fa-database (cache)
  input: "\uF090",      // nf-fa-sign_in (input arrow)
  output: "\uF08B",     // nf-fa-sign_out (output arrow)
  host: "\uF109",       // nf-fa-laptop (host)
  session: "\uF550",    // nf-md-identifier (session id)
  auto: "\u{F0068}",    // nf-md-lightning_bolt (auto-compact)
  warning: "\uF071",    // nf-fa-warning
};

// ASCII/Unicode fallback icons (matching oh-my-pi)
export const ASCII_ICONS: IconSet = {
  pi: "π",
  model: "",
  folder: "dir",
  branch: "⎇",
  git: "⎇",
  tokens: "⊛",
  context: "◫",
  thinking: "~",
  cost: "$",
  time: "◷",
  agents: "AG",
  cache: "cache",
  input: "in:",
  output: "out:",
  host: "host",
  session: "id",
  auto: "AC",
  warning: "!",
};

type PartialIconSet = Partial<IconSet>;

function sanitizeUserIconOverrides(value: unknown): PartialIconSet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const sanitized: PartialIconSet = {};
  const validKeys = Object.keys(NERD_ICONS) as Array<keyof IconSet>;
  for (const key of validKeys) {
    const icon = value[key];
    if (typeof icon === "string") {
      sanitized[key] = icon;
    }
  }

  return sanitized;
}

// Separator characters
export interface SeparatorChars {
  powerlineLeft: string;
  powerlineRight: string;
  powerlineThinLeft: string;
  powerlineThinRight: string;
  slash: string;
  pipe: string;
  block: string;
  space: string;
  asciiLeft: string;
  asciiRight: string;
  dot: string;
}

export const NERD_SEPARATORS: SeparatorChars = {
  powerlineLeft: "\uE0B0",    // 
  powerlineRight: "\uE0B2",   // 
  powerlineThinLeft: "\uE0B1", // 
  powerlineThinRight: "\uE0B3", // 
  slash: "/",
  pipe: "|",
  block: "█",
  space: " ",
  asciiLeft: ">",
  asciiRight: "<",
  dot: "·",
};

export const ASCII_SEPARATORS: SeparatorChars = {
  powerlineLeft: ">",
  powerlineRight: "<",
  powerlineThinLeft: "|",
  powerlineThinRight: "|",
  slash: "/",
  pipe: "|",
  block: "#",
  space: " ",
  asciiLeft: ">",
  asciiRight: "<",
  dot: ".",
};

// Detect Nerd Font support. Primary control is the powerline config (set via
// setNerdFontsPreference); the POWERLINE_NERD_FONTS env var is an optional
// override.
let configuredNerdFonts: boolean | null = null;

/**
 * Record the Nerd Font preference coming from powerline config (settings.json).
 * This is the primary control. Pass `null`/`undefined` to clear it (fall back to
 * the env var, then the default). The extension keeps this in sync whenever the
 * powerline config is (re)loaded.
 */
export function setNerdFontsPreference(value: boolean | null | undefined): void {
  configuredNerdFonts = value ?? null;
}

export function hasNerdFonts(): boolean {
  // The POWERLINE_NERD_FONTS env var is an optional override (an escape hatch for
  // a specific shell/terminal) and wins whenever it is explicitly set.
  const override = process.env.POWERLINE_NERD_FONTS;
  if (override === "1") return true;
  if (override === "0") return false;

  // Primary control: the powerline config in settings.json.
  if (configuredNerdFonts !== null) return configuredNerdFonts;

  // Default to Nerd Font glyphs. In practice, the powerline footer is used in
  // terminals that already ship with a patched font, and falling back to the
  // ASCII icon set makes many segments look broken/blank.
  return true;
}

export function getIcons(): IconSet {
  const baseIcons = hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
  return {
    ...baseIcons,
    ...sanitizeUserIconOverrides(loadThemeConfig().icons),
  };
}

export function getSeparatorChars(): SeparatorChars {
  return hasNerdFonts() ? NERD_SEPARATORS : ASCII_SEPARATORS;
}
