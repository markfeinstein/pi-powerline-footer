import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const CURSOR_MARKER = "\x1b_pi:c\x07";
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

/**
 * Reduce a pi status line (e.g. `"⠋ Working…"`) to just its leading spinner
 * glyph, dropping the trailing message text. ANSI styling around the glyph is
 * preserved. Returns "" if there is no visible content.
 */
export function keepSpinnerGlyph(statusLine: string): string {
  const ansiRe = /\x1b\[[0-9;]*m/y;
  let out = "";
  let seenGlyph = false;
  let i = 0;
  while (i < statusLine.length) {
    ansiRe.lastIndex = i;
    const m = ansiRe.exec(statusLine);
    if (m) {
      out += m[0];
      i = ansiRe.lastIndex;
      continue;
    }
    const ch = statusLine[i];
    const isSpace = /\s/.test(ch);
    if (!seenGlyph) {
      if (isSpace) {
        i++;
        continue;
      }
      seenGlyph = true;
      out += ch;
      i++;
    } else {
      if (isSpace) break;
      out += ch;
      i++;
    }
  }
  return seenGlyph ? out + "\x1b[0m" : "";
}

/**
 * Prefix the powerline bar line with a fixed-width spinner slot so the bar text
 * stays put whether or not the spinner is showing. The slot is one column wide
 * (plus a leading and trailing space); when `spinnerGlyph` is empty the slot is
 * rendered as blanks. ANSI styling on the glyph is preserved.
 */
export function reserveSpinnerSlot(barLine: string, spinnerGlyph: string): string {
  const glyph = keepSpinnerGlyph(spinnerGlyph) || spinnerGlyph.trim();
  const cell = glyph ? glyph : " ";
  return ` ${cell} ${barLine.replace(/^\s+/, "")}`;
}

/**
 * Net extra columns that reserveSpinnerSlot adds to a bar line which begins with
 * a single leading space (as powerline bar lines always do): the 3-column slot
 * (` x `) replaces that 1-column leading space. Callers that right-align content
 * flush to the terminal edge must subtract this from the available width so the
 * composed line does not overflow and wrap the rightmost glyphs.
 */
export const SPINNER_SLOT_RESERVE = 2;

export interface FixedEditorClusterInput {
  width: number;
  terminalRows: number;
  statusLines?: string[];
  topLines?: string[];
  editorLines: string[];
  secondaryLines?: string[];
  transcriptLines?: string[];
  lastPromptLines?: string[];
  /** Where the status bar renders relative to the editor. Default "above". */
  statusPosition?: "above" | "below";
  /** Where the last-prompt rows render relative to the editor. Default "below". */
  lastPromptPosition?: "above" | "below";
  /**
   * Lines contributed by third-party `aboveEditor` widgets (e.g. a todo list).
   * These always render directly above the editor and are NOT affected by
   * `statusPosition`/`statusBelowPrompt` (unlike the powerline status rows).
   */
  aboveEditorWidgetLines?: string[];
}

export interface FixedEditorCursor {
  row: number;
  col: number;
}

export interface FixedEditorClusterRender {
  lines: string[];
  cursor: FixedEditorCursor | null;
}

interface NormalizedLinesCacheEntry {
  signature: string;
  lines: string[];
}

const normalizedLinesCache = new WeakMap<readonly string[], Map<number, NormalizedLinesCacheEntry>>();

function linesSignature(lines: readonly string[] | undefined): string {
  if (!lines) return "";

  let signature = `${lines.length}`;
  for (const line of lines) {
    const value = line ?? "";
    signature += `:${value.length}:${value}`;
  }
  return signature;
}

function normalizeLines(lines: string[] | undefined, width: number, signature = linesSignature(lines)): string[] {
  if (!lines || width <= 0) return [];

  const cachedWidths = normalizedLinesCache.get(lines);
  const cached = cachedWidths?.get(width);
  if (cached?.signature === signature) return cached.lines;

  const normalized: string[] = [];
  for (const line of lines) {
    if (line === undefined || line === null) continue;
    normalized.push(visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line);
  }

  let widths = cachedWidths;
  if (!widths) {
    widths = new Map<number, NormalizedLinesCacheEntry>();
    normalizedLinesCache.set(lines, widths);
  }
  widths.set(width, { signature, lines: normalized });
  return normalized;
}

function takeTail(lines: string[], count: number): string[] {
  if (count <= 0) return [];
  return lines.length <= count ? lines : lines.slice(lines.length - count);
}

function capEditorLines(lines: string[], count: number): string[] {
  if (count <= 0) return [];
  if (lines.length <= count) return lines;

  const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  if (cursorRow !== -1) {
    const start = Math.max(0, Math.min(cursorRow - count + 1, lines.length - count));
    return lines.slice(start, start + count);
  }

  const selectedRow = lines.findIndex((line) => stripAnsi(line).trimStart().startsWith("→ "));
  if (selectedRow === -1) {
    return lines.slice(0, count);
  }

  const start = Math.max(0, Math.min(selectedRow - Math.floor(count / 2), lines.length - count));
  return lines.slice(start, start + count);
}

function extractCursor(lines: string[]): FixedEditorClusterRender {
  let cursor: FixedEditorCursor | null = null;
  const cleaned = lines.map((line, row) => {
    const markerIndex = line.indexOf(CURSOR_MARKER);
    if (markerIndex === -1) return line;

    if (!cursor) {
      cursor = {
        row,
        col: visibleWidth(line.slice(0, markerIndex)),
      };
    }

    return line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
  });

  return { lines: cleaned, cursor };
}

interface ClusterCacheEntry {
  width: number;
  terminalRows: number;
  statusLines?: string[];
  statusLinesSignature: string;
  topLines?: string[];
  topLinesSignature: string;
  editorLines: string[];
  editorLinesSignature: string;
  secondaryLines?: string[];
  secondaryLinesSignature: string;
  transcriptLines?: string[];
  transcriptLinesSignature: string;
  lastPromptLines?: string[];
  lastPromptLinesSignature: string;
  statusPosition?: "above" | "below";
  lastPromptPosition?: "above" | "below";
  aboveEditorWidgetLines?: string[];
  aboveEditorWidgetLinesSignature: string;
  result: FixedEditorClusterRender;
}

let lastClusterCache: ClusterCacheEntry | null = null;

export function renderFixedEditorCluster(input: FixedEditorClusterInput): FixedEditorClusterRender {
  const width = Math.max(1, input.width);
  const maxRows = Math.max(1, input.terminalRows - 1);
  const statusLinesSignature = linesSignature(input.statusLines);
  const topLinesSignature = linesSignature(input.topLines);
  const editorLinesSignature = linesSignature(input.editorLines);
  const secondaryLinesSignature = linesSignature(input.secondaryLines);
  const transcriptLinesSignature = linesSignature(input.transcriptLines);
  const lastPromptLinesSignature = linesSignature(input.lastPromptLines);
  const aboveEditorWidgetLinesSignature = linesSignature(input.aboveEditorWidgetLines);

  if (
    lastClusterCache
    && lastClusterCache.width === width
    && lastClusterCache.terminalRows === input.terminalRows
    && lastClusterCache.statusLines === input.statusLines
    && lastClusterCache.statusLinesSignature === statusLinesSignature
    && lastClusterCache.topLines === input.topLines
    && lastClusterCache.topLinesSignature === topLinesSignature
    && lastClusterCache.editorLines === input.editorLines
    && lastClusterCache.editorLinesSignature === editorLinesSignature
    && lastClusterCache.secondaryLines === input.secondaryLines
    && lastClusterCache.secondaryLinesSignature === secondaryLinesSignature
    && lastClusterCache.transcriptLines === input.transcriptLines
    && lastClusterCache.transcriptLinesSignature === transcriptLinesSignature
    && lastClusterCache.lastPromptLines === input.lastPromptLines
    && lastClusterCache.lastPromptLinesSignature === lastPromptLinesSignature
    && lastClusterCache.statusPosition === input.statusPosition
    && lastClusterCache.lastPromptPosition === input.lastPromptPosition
    && lastClusterCache.aboveEditorWidgetLines === input.aboveEditorWidgetLines
    && lastClusterCache.aboveEditorWidgetLinesSignature === aboveEditorWidgetLinesSignature
  ) {
    return lastClusterCache.result;
  }

  // Drop blank status rows (empty or whitespace-only) so an empty
  // widget/notification line doesn't leave a gap between the editor and the bar.
  const statusLines = normalizeLines(input.statusLines, width, statusLinesSignature).filter((line) => stripAnsi(line).trim().length > 0);
  const topLines = normalizeLines(input.topLines, width, topLinesSignature);
  const editorSource = normalizeLines(input.editorLines, width, editorLinesSignature);
  const secondaryLines = normalizeLines(input.secondaryLines, width, secondaryLinesSignature);
  const transcriptLines = normalizeLines(input.transcriptLines, width, transcriptLinesSignature);
  const lastPromptLines = normalizeLines(input.lastPromptLines, width, lastPromptLinesSignature);
  const aboveEditorWidgetLines = normalizeLines(input.aboveEditorWidgetLines, width, aboveEditorWidgetLinesSignature);

  const editorLines = capEditorLines(editorSource, maxRows);
  let remaining = maxRows - editorLines.length;

  const takeRemaining = (lines: string[]): string[] => {
    const taken = takeTail(lines, remaining);
    remaining -= taken.length;
    return taken;
  };

  const statusBelow = input.statusPosition === "below";
  const lastPromptAbove = input.lastPromptPosition === "above";

  let status: string[] = [];
  let top: string[] = [];
  let aboveEditorWidget: string[] = [];
  let secondary: string[] = [];
  let transcript: string[] = [];
  let lastPromptAboveLines: string[] = [];
  let lastPromptBelowLines: string[] = [];

  if (statusBelow) {
    aboveEditorWidget = takeRemaining(aboveEditorWidgetLines);
    if (lastPromptAbove) {
      lastPromptAboveLines = takeRemaining(lastPromptLines);
    }
    status = takeRemaining(statusLines);
    top = takeRemaining(topLines);
    secondary = takeRemaining(secondaryLines);
    transcript = takeRemaining(transcriptLines);
    if (!lastPromptAbove) {
      lastPromptBelowLines = takeRemaining(lastPromptLines);
    }
  } else {
    top = takeRemaining(topLines);
    aboveEditorWidget = takeRemaining(aboveEditorWidgetLines);
    secondary = takeRemaining(secondaryLines);
    if (lastPromptAbove) {
      lastPromptAboveLines = takeRemaining(lastPromptLines);
    }
    status = takeRemaining(statusLines);
    transcript = takeRemaining(transcriptLines);
    if (!lastPromptAbove) {
      lastPromptBelowLines = takeRemaining(lastPromptLines);
    }
  }

  // The visible powerline bar is carried by `top`; `status` holds notification
  // rows. When statusBelow is set, both move beneath the editor (preserving
  // their default top->bottom order: status, then top).
  const result = extractCursor([
    ...(statusBelow ? [] : status),
    ...(statusBelow ? [] : top),
    ...aboveEditorWidget,
    ...lastPromptAboveLines,
    ...editorLines,
    ...(statusBelow ? status : []),
    ...(statusBelow ? top : []),
    ...secondary,
    ...transcript,
    ...lastPromptBelowLines,
  ]);

  lastClusterCache = {
    width,
    terminalRows: input.terminalRows,
    statusLines: input.statusLines,
    statusLinesSignature,
    topLines: input.topLines,
    topLinesSignature,
    editorLines: input.editorLines,
    editorLinesSignature,
    secondaryLines: input.secondaryLines,
    secondaryLinesSignature,
    transcriptLines: input.transcriptLines,
    transcriptLinesSignature,
    lastPromptLines: input.lastPromptLines,
    lastPromptLinesSignature,
    statusPosition: input.statusPosition,
    lastPromptPosition: input.lastPromptPosition,
    aboveEditorWidgetLines: input.aboveEditorWidgetLines,
    aboveEditorWidgetLinesSignature,
    result,
  };

  return result;
}
