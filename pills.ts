// Pill rendering: wrap status segments in rounded half-circle caps with a
// solid background fill. Rounded caps require a Nerd Font. Colors may use
// truecolor hex values or the terminal's 16-color ANSI palette.
import { ansi } from "./colors.ts";

/** Left rounded cap (nf-ple-left_half_circle_thick, U+E0B6). */
export const PILL_LEFT_CAP = "\uE0B6";
/** Right rounded cap (nf-ple-right_half_circle_thick, U+E0B4). */
export const PILL_RIGHT_CAP = "\uE0B4";

/** Default pill background when none is configured. */
export const DEFAULT_PILL_BACKGROUND = "#3b4252";

function ansiPaletteIndex(color: string): number | null {
  const match = /^ansi:([0-9]|1[0-5])$/.exec(color);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.slice(1);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function bgAnsi(color: string): string {
  const paletteIndex = ansiPaletteIndex(color);
  return paletteIndex === null
    ? ansi.getBgAnsi(...hexToRgb(color))
    : ansi.getBgAnsi256(paletteIndex);
}

function fgAnsi(color: string): string {
  if (color === "default") return "\x1b[39m";
  const paletteIndex = ansiPaletteIndex(color);
  return paletteIndex === null
    ? ansi.getFgAnsi(...hexToRgb(color))
    : ansi.getFgAnsi256(paletteIndex);
}

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function coloredPillBody(content: string, textHex: string, iconHex?: string): string {
  const plain = stripSgr(content);
  if (!iconHex) {
    return `${fgAnsi(textHex)}${plain}`;
  }

  const iconBoundary = plain.indexOf(" ");
  if (iconBoundary <= 0) {
    return `${fgAnsi(textHex)}${plain}`;
  }

  return `${fgAnsi(iconHex)}${plain.slice(0, iconBoundary)}${fgAnsi(textHex)}${plain.slice(iconBoundary)}`;
}

export interface PillSegment {
  id?: string;
  content: string;
  bg: string;
  /** Optional text color. When set, the segment's own colors are replaced. */
  fg?: string;
  /** Optional color for the leading icon token before the first space. */
  iconFg?: string;
  leadingSpace?: boolean;
  trailingSpace?: boolean;
}

const NO_TRAILING_SPACE = new Set([
  "token_in",
  "token_out",
  "cache_read",
  "cache_write",
  "thinking",
  "git",
  "cost",
]);

/** Wrap one pre-rendered segment in a filled pill. */
export function wrapInPill(content: string, bgHex: string): string {
  return wrapInPillGroup([{ content, bg: bgHex }]);
}

/**
 * Render one pill that may contain multiple adjacent segments. Each segment can
 * use a distinct background; only the outer edges receive rounded caps.
 */
export function wrapInPillGroup(items: readonly PillSegment[], bold = false): string {
  if (items.length === 0) return "";

  const reset = ansi.reset;
  const boldAnsi = bold ? "\x1b[1m" : "";
  let output = `${fgAnsi(items[0]!.bg)}${PILL_LEFT_CAP}${reset}`;

  for (const item of items) {
    const background = bgAnsi(item.bg);
    const body = item.fg
      ? `${boldAnsi}${coloredPillBody(item.content, item.fg, item.iconFg)}`
      : item.content.split(reset).join(`${reset}${background}${boldAnsi}`);
    output += `${background}${item.leadingSpace ? " " : ""}${boldAnsi}${body}${item.trailingSpace === false ? "" : " "}`;
  }

  output += `${reset}${fgAnsi(items[items.length - 1]!.bg)}${PILL_RIGHT_CAP}${reset}`;
  return output;
}

/**
 * Partition ordered visible segments into pill units. Adjacent segments in the
 * same configured group share one capsule; all other segments get their own.
 */
export function buildPillUnits(
  parts: readonly { id: string; content: string; pillColorKey?: string }[],
  groups: readonly (readonly string[])[],
  colors: Readonly<Record<string, string>>,
  defaultBg: string,
  fgColors: Readonly<Record<string, string>> = {},
  defaultFg = "",
  iconColors: Readonly<Record<string, string>> = {},
  defaultIconFg = "",
): PillSegment[][] {
  const groupIndexOf = (id: string): number => groups.findIndex((group) => group.includes(id));
  const units: PillSegment[][] = [];
  let currentGroup: number | null = null;

  for (const part of parts) {
    const groupIndex = groupIndexOf(part.id);
    const continuesGroup = groupIndex !== -1 && groupIndex === currentGroup && units.length > 0;
    const foreground = fgColors[part.id] ?? defaultFg;
    const iconForeground = foreground ? (iconColors[part.id] ?? defaultIconFg) : "";
    const segment: PillSegment = {
      id: part.id,
      content: part.content,
      bg: (part.pillColorKey ? colors[part.pillColorKey] : undefined) ?? colors[part.id] ?? defaultBg,
      leadingSpace: continuesGroup,
      trailingSpace: !NO_TRAILING_SPACE.has(part.id),
      ...(foreground ? { fg: foreground } : {}),
      ...(iconForeground ? { iconFg: iconForeground } : {}),
    };

    if (continuesGroup) {
      units[units.length - 1]!.push(segment);
    } else {
      units.push([segment]);
      currentGroup = groupIndex === -1 ? null : groupIndex;
    }
  }

  return units;
}
