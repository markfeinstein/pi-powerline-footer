/**
 * Theme system for powerline-footer
 * 
 * Colors are resolved in order:
 * 1. User overrides from theme.json (if exists)
 * 2. Preset colors
 * 3. Default colors
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ColorScheme, ColorValue, SemanticColor, ThemeLike } from "./types.ts";
import { stripTerminalControlSequences } from "./sanitize.ts";

export interface PowerlineThemeConfig {
  colors?: unknown;
  icons?: unknown;
}

// Default color scheme (uses pi theme colors)
const DEFAULT_COLORS: Required<ColorScheme> = {
  model: "#d787af",  // Pink/mauve (matching original colors.ts)
  shellMode: "accent",
  path: "#00afaf",  // Teal/cyan (matching original colors.ts)
  gitDirty: "warning",
  gitClean: "success",
  thinking: "thinkingOff",
  thinkingMinimal: "thinkingMinimal",
  thinkingLow: "thinkingLow",
  thinkingMedium: "thinkingMedium",
  context: "dim",
  contextWarn: "warning",
  contextError: "error",
  cost: "text",
  tokens: "muted",
  separator: "dim",
  border: "borderMuted",
};

// Rainbow colors for high thinking levels
const RAINBOW_COLORS = [
  "#b281d6", "#d787af", "#febc38", "#e4c00f", 
  "#89d281", "#00afaf", "#178fb9", "#b281d6",
];

// Cache for user theme overrides
let userThemeCache: ColorScheme | null = null;
let userThemeCacheSource: PowerlineThemeConfig | null = null;
let themeConfigCache: { fingerprint: string; value: PowerlineThemeConfig } | null = null;
const MAX_THEME_FILE_BYTES = 64 * 1024;
const warnedInvalidThemeColors = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeUserThemeOverrides(value: unknown): ColorScheme {
  if (!isRecord(value)) {
    return {};
  }

  const sanitized: ColorScheme = {};
  for (const [key, rawColor] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_COLORS, key)) {
      continue;
    }
    if (typeof rawColor !== "string") {
      continue;
    }

    // Strip terminal control sequences before trimming: a color value is later
    // emitted near ANSI codes (or passed to the host theme), so an override must
    // never be able to smuggle escape codes into the bar.
    const color = stripTerminalControlSequences(rawColor).replace(/[\r\n\t]/g, "").trim();
    if (!color) {
      continue;
    }

    sanitized[key as SemanticColor] = color as ColorValue;
  }

  return sanitized;
}

/**
 * Get the path to the theme.json file
 */
let cachedThemePath: string | null = null;
function getThemePath(): string {
  // import.meta.url is constant for the process lifetime, so resolve the
  // theme.json path once. loadThemeConfig() is on the render hot path and was
  // recomputing fileURLToPath + dirname + join on every call.
  if (cachedThemePath === null) {
    cachedThemePath = join(dirname(fileURLToPath(import.meta.url)), "theme.json");
  }
  return cachedThemePath;
}

/**
 * Load user theme config from theme.json
 */
export function loadThemeConfig(): PowerlineThemeConfig {
  const themePath = getThemePath();

  // A single lstat replaces the previous existsSync + lstatSync pair (two
  // filesystem syscalls collapse to one). loadThemeConfig runs many times per
  // layout recompute (once per colored segment + once per getIcons), so the
  // halved syscall count adds up. `throwIfNoEntry: false` returns undefined for a
  // missing file instead of throwing (V8 exception handling is far slower than a
  // plain return on the common no-theme.json path). lstat does not follow
  // symlinks, so a symlinked theme.json still fails the isFile() guard below.
  let stats: Stats | undefined;
  try {
    stats = lstatSync(themePath, { throwIfNoEntry: false });
  } catch {
    stats = undefined;
  }

  if (stats) {
    try {
      if (!stats.isFile() || stats.size > MAX_THEME_FILE_BYTES) {
        console.debug(`[powerline-theme] Ignoring unsafe theme path at ${themePath}`);
        themeConfigCache = { fingerprint: `${themePath}:unsafe`, value: {} };
        return themeConfigCache.value;
      }

      const fingerprint = `${themePath}:${stats.size}:${stats.mtimeMs}`;
      if (themeConfigCache?.fingerprint === fingerprint) {
        return themeConfigCache.value;
      }

      const content = readFileSync(themePath, "utf-8");
      const parsed = JSON.parse(content);
      const value = isRecord(parsed) ? parsed : {};
      themeConfigCache = { fingerprint, value };
      return value;
    } catch (error) {
      // Theme overrides are optional. If the file is unreadable or malformed,
      // keep rendering with built-in defaults instead of breaking the footer.
      console.debug(`[powerline-theme] Failed to load ${themePath}:`, error);
    }
  }

  const fingerprint = `${themePath}:missing`;
  if (themeConfigCache?.fingerprint === fingerprint) {
    return themeConfigCache.value;
  }
  themeConfigCache = { fingerprint, value: {} };
  return themeConfigCache.value;
}

function loadUserTheme(): ColorScheme {
  const themeConfig = loadThemeConfig();
  if (userThemeCache && userThemeCacheSource === themeConfig) {
    return userThemeCache;
  }

  userThemeCache = sanitizeUserThemeOverrides(themeConfig.colors);
  userThemeCacheSource = themeConfig;
  return userThemeCache;
}

/**
 * Resolve a semantic color to an actual color value
 */
export function resolveColor(
  semantic: SemanticColor,
  presetColors?: ColorScheme
): ColorValue {
  const userTheme = loadUserTheme();
  
  // Priority: user overrides > preset colors > defaults
  return userTheme[semantic] 
    ?? presetColors?.[semantic] 
    ?? DEFAULT_COLORS[semantic];
}

/**
 * Check if a color value is a hex color
 */
function isHexColor(color: ColorValue): color is `#${string}` {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

/**
 * Convert hex color to ANSI escape code
 */
function hexToAnsi(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Apply a color to text using the pi theme or custom hex
 */
export function applyColor(
  theme: ThemeLike,
  color: ColorValue,
  text: string
): string {
  if (isHexColor(color)) {
    return `${hexToAnsi(color)}${text}\x1b[0m`;
  }

  try {
    return theme.fg(color as ThemeColor, text);
  } catch (error) {
    const key = String(color);
    if (!warnedInvalidThemeColors.has(key)) {
      warnedInvalidThemeColors.add(key);
      if (warnedInvalidThemeColors.size > 200) {
        warnedInvalidThemeColors.clear();
      }
      console.debug(`[powerline-theme] Invalid theme color "${key}"; falling back to "text".`, error);
    }
    return theme.fg("text", text);
  }
}

/**
 * Apply a semantic color to text
 */
export function fg(
  theme: ThemeLike,
  semantic: SemanticColor,
  text: string,
  presetColors?: ColorScheme
): string {
  const color = resolveColor(semantic, presetColors);
  return applyColor(theme, color, text);
}

/**
 * Apply rainbow gradient to text (for high thinking levels)
 */
export function rainbow(text: string): string {
  let result = "";
  let colorIndex = 0;
  for (const char of text) {
    if (char === " " || char === ":") {
      result += char;
    } else {
      result += hexToAnsi(RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]) + char;
      colorIndex++;
    }
  }
  return result + "\x1b[0m";
}

/**
 * Get the default color scheme
 */
export function getDefaultColors(): Required<ColorScheme> {
  return { ...DEFAULT_COLORS };
}
