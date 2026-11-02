// Pill rendering: wrap status segments in rounded half-circle caps with a
// solid background fill. Rounded caps require a Nerd Font and pill colors
// require a truecolor terminal.
import { ansi } from "./colors.ts";

/** Left rounded cap (nf-ple-left_half_circle_thick, U+E0B6). */
export const PILL_LEFT_CAP = "\uE0B6";
/** Right rounded cap (nf-ple-right_half_circle_thick, U+E0B4). */
export const PILL_RIGHT_CAP = "\uE0B4";

/** Default pill background when none is configured. */
export const DEFAULT_PILL_BACKGROUND = "#3b4252";

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.slice(1);
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function bgAnsi(hex: string): string {
  return ansi.getBgAnsi(...hexToRgb(hex));
}

function capAnsi(hex: string): string {
  return ansi.getFgAnsi(...hexToRgb(hex));
}

function fgAnsi(hex: string): string {
  return ansi.getFgAnsi(...hexToRgb(hex));
}

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export interface PillSegment {
  id?: string;
  content: string;
  bg: string;
  /** Optional text/icon color. When set, the segment's own colors are replaced. */
  fg?: string;
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
  let output = `${capAnsi(items[0]!.bg)}${PILL_LEFT_CAP}${reset}`;

  for (const item of items) {
    const background = bgAnsi(item.bg);
    const body = item.fg
      ? `${boldAnsi}${fgAnsi(item.fg)}${stripSgr(item.content)}`
      : item.content.split(reset).join(`${reset}${background}${boldAnsi}`);
    output += `${background}${item.leadingSpace ? " " : ""}${boldAnsi}${body}${item.trailingSpace === false ? "" : " "}`;
  }

  output += `${reset}${capAnsi(items[items.length - 1]!.bg)}${PILL_RIGHT_CAP}${reset}`;
  return output;
}

/**
 * Partition ordered visible segments into pill units. Adjacent segments in the
 * same configured group share one capsule; all other segments get their own.
 */
export function buildPillUnits(
  parts: readonly { id: string; content: string }[],
  groups: readonly (readonly string[])[],
  colors: Readonly<Record<string, string>>,
  defaultBg: string,
  fgColors: Readonly<Record<string, string>> = {},
  defaultFg = "",
): PillSegment[][] {
  const groupIndexOf = (id: string): number => groups.findIndex((group) => group.includes(id));
  const units: PillSegment[][] = [];
  let currentGroup: number | null = null;

  for (const part of parts) {
    const groupIndex = groupIndexOf(part.id);
    const continuesGroup = groupIndex !== -1 && groupIndex === currentGroup && units.length > 0;
    const foreground = fgColors[part.id] ?? defaultFg;
    const segment: PillSegment = {
      id: part.id,
      content: part.content,
      bg: colors[part.id] ?? defaultBg,
      leadingSpace: continuesGroup,
      trailingSpace: !NO_TRAILING_SPACE.has(part.id),
      ...(foreground ? { fg: foreground } : {}),
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
