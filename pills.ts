// Pill rendering: wrap each status segment in rounded half-circle caps with a
// solid background fill. Requires a Nerd Font (for the cap glyphs) and a
// truecolor terminal (for the background).
import { ansi } from "./colors.ts";

/** Left rounded cap (nf-ple-left_half_circle_thick, U+E0B6). */
export const PILL_LEFT_CAP = "\uE0B6";
/** Right rounded cap (nf-ple-right_half_circle_thick, U+E0B4). */
export const PILL_RIGHT_CAP = "\uE0B4";

/** Default pill background when none is configured. */
export const DEFAULT_PILL_BACKGROUND = "#3b4252";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Wrap pre-rendered segment content in a filled pill. The caps are drawn in the
 * pill color (on the terminal background), and the content sits on a solid
 * background of that color. Any reset sequences inside `content` re-assert the
 * background so multi-colored segments stay filled edge to edge.
 */
export function wrapInPill(content: string, bgHex: string): string {
  return wrapInPillGroup([{ content, bg: bgHex }]);
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

const NO_TRAILING_SPACE = new Set(["token_in", "token_out", "cache_read", "cache_write", "thinking", "git"]);

function bgAnsi(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return ansi.getBgAnsi(r, g, b);
}

function capAnsi(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return ansi.getFgAnsi(r, g, b);
}

function fgAnsi(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return ansi.getFgAnsi(r, g, b);
}

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Render one pill that may contain several segments, each with its own
 * background color. The outer rounded caps match the first and last segment
 * colors; the boundary between adjacent segments is a hard color transition
 * (no gap), so a multi-segment pill reads as a single rounded capsule with
 * two-tone (or more) fills. When a segment has an `fg`, its text/icons are
 * recolored to that color (replacing the segment's own colors) for contrast.
 */
export function wrapInPillGroup(items: PillSegment[], bold = false): string {
  if (items.length === 0) return "";
  const reset = ansi.reset;
  const b = bold ? "\x1b[1m" : "";
  let out = `${capAnsi(items[0].bg)}${PILL_LEFT_CAP}${reset}`;
  for (const it of items) {
    const bg = bgAnsi(it.bg);
    const body = it.fg
      ? `${b}${fgAnsi(it.fg)}${stripSgr(it.content)}`
      : it.content.split(reset).join(reset + bg + b);
    out += `${bg}${it.leadingSpace ? " " : ""}${b}${body}${it.trailingSpace === false ? "" : " "}`;
  }
  out += `${reset}${capAnsi(items[items.length - 1].bg)}${PILL_RIGHT_CAP}${reset}`;
  return out;
}

/**
 * Partition ordered segments into pill "units". Consecutive segments that belong
 * to the same configured group are merged into one multi-segment pill; every other
 * segment becomes its own single-segment pill. Each segment's background is
 * `colors[id]` when set, otherwise `defaultBg`; its text color is `fgColors[id]`
 * when set, otherwise `defaultFg` (empty string = keep the segment's own colors).
 */
export function buildPillUnits(
  parts: { id: string; content: string }[],
  groups: readonly (readonly string[])[],
  colors: Record<string, string>,
  defaultBg: string,
  fgColors: Record<string, string> = {},
  defaultFg = "",
): PillSegment[][] {
  const groupIndexOf = (id: string): number => groups.findIndex((g) => g.includes(id));
  const units: PillSegment[][] = [];
  let currentGroup: number | null = null;
  for (const p of parts) {
    const gi = groupIndexOf(p.id);
    const fg = fgColors[p.id] ?? defaultFg;
    const seg: PillSegment = {
      id: p.id,
      content: p.content,
      bg: colors[p.id] ?? defaultBg,
      trailingSpace: !NO_TRAILING_SPACE.has(p.id),
    };
    if (gi !== -1 && gi === currentGroup && units.length > 0) {
      seg.leadingSpace = true;
    }
    if (fg) seg.fg = fg;
    if (gi !== -1 && gi === currentGroup && units.length > 0) {
      units[units.length - 1].push(seg);
    } else {
      units.push([seg]);
      currentGroup = gi === -1 ? null : gi;
    }
  }
  return units;
}
