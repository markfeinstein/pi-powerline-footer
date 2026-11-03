import { loadThemeConfig } from "./theme.ts";

export interface IconSet {
  pi: string;
  model: string;
  thinking: string;
  providerGithub: string;
  providerOpenai: string;
  providerAnthropic: string;
  folder: string;
  branch: string;
  git: string;
  github: string;
  gitlab: string;
  bitbucket: string;
  tokens: string;
  context: string;
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
  model: "\uEC19",      // nf-cod-chip (generic model/AI chip)
  thinking: "\u{F09D1}", // nf-md-brain
  providerGithub: "\uF09B",    // nf-fa-github
  providerOpenai: "\uEC81",    // nf-cod-openai
  providerAnthropic: "\uEC82", // nf-cod-claude
  folder: "\uF115",     // nf-fa-folder_open
  branch: "\uF126",     // nf-fa-code_fork (git branch)
  git: "\uF1D3",        // nf-fa-git (git logo)
  github: "\uF09B",     // nf-fa-github (octocat)
  gitlab: "\uF296",     // nf-fa-gitlab (tanuki)
  bitbucket: "\uF171",  // nf-fa-bitbucket
  tokens: "\uE26B",     // nf-seti-html (tokens symbol)
  context: "\u{F035B}",  // nf-md-memory (context window)
  cost: "\uF155",       // nf-fa-dollar
  time: "\uF017",       // nf-fa-clock_o
  agents: "\uF0C0",     // nf-fa-users
  cache: "\u{F00E8}",    // nf-md-cached (prompt cache)
  input: "\uF090",      // nf-fa-sign_in (input arrow)
  output: "\uF08B",     // nf-fa-sign_out (output arrow)
  host: "\uF109",       // nf-fa-laptop (host)
  session: "\uF550",    // nf-md-identifier (session id)
  auto: "\u{F0615}",    // nf-md-arrow_collapse (auto-compact)
  warning: "\uF071",    // nf-fa-warning
};

// ASCII/Unicode fallback icons (matching oh-my-pi)
export const ASCII_ICONS: IconSet = {
  pi: "π",
  model: "",
  thinking: "🧠",
  providerGithub: "GH",
  providerOpenai: "OA",
  providerAnthropic: "AN",
  folder: "dir",
  branch: "⎇",
  git: "⎇",
  github: "⎇",
  gitlab: "⎇",
  bitbucket: "⎇",
  tokens: "⊛",
  context: "◫",
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
    const icon = Reflect.get(value, key);
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

// Infer Nerd Font support from an environment override, the Powerline setting,
// and finally terminal-name heuristics.
let configuredNerdFonts: boolean | null = null;

export function setNerdFontsPreference(value: boolean | null | undefined): void {
  configuredNerdFonts = value ?? null;
}

export function hasNerdFonts(): boolean {
  // Environment remains the per-terminal escape hatch and wins when explicit.
  if (process.env.POWERLINE_NERD_FONTS === "1") return true;
  if (process.env.POWERLINE_NERD_FONTS === "0") return false;

  if (configuredNerdFonts !== null) return configuredNerdFonts;

  // Check for Ghostty (survives into tmux via GHOSTTY_RESOURCES_DIR)
  if (process.env.GHOSTTY_RESOURCES_DIR) return true;

  // Use TERM only when TERM_PROGRAM is unset (e.g. kitty uses TERM=xterm-kitty).
  // Terminal names are a heuristic, not detection of the configured font.
  const term = (process.env.TERM_PROGRAM ?? process.env.TERM ?? "").toLowerCase();
  const nerdTerms = ["iterm", "wezterm", "kitty", "ghostty", "alacritty", "kaku"];
  return nerdTerms.some(t => term.includes(t));
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
