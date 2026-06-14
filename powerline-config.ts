import { visibleWidth } from "@earendil-works/pi-tui";
import type { BuiltinStatusLineSegmentId, ColorValue, CustomItemPosition, CustomLayoutConfig, CustomStatusItem, PresetDef, StatusLinePreset, StatusLineSegmentId, StatusLineSegmentOptions } from "./types.ts";
import { isSeparatorStyle } from "./separators.ts";
import { DEFAULT_PILL_BACKGROUND } from "./pills.ts";

// Runtime set of every built-in segment id. The `satisfies` check makes the
// compiler fail if a BuiltinStatusLineSegmentId is added/removed without
// updating this map, keeping it in sync with the type union (avoids importing
// SEGMENTS from segments.ts, which would create an import cycle).
const BUILTIN_SEGMENT_ID_SET = {
  model: true,
  shell_mode: true,
  path: true,
  git: true,
  subagents: true,
  token_in: true,
  token_out: true,
  token_total: true,
  cost: true,
  context_pct: true,
  context_total: true,
  time_spent: true,
  time: true,
  session: true,
  hostname: true,
  cache_read: true,
  cache_write: true,
  thinking: true,
  extension_statuses: true,
} satisfies Record<BuiltinStatusLineSegmentId, true>;

export interface PowerlineConfig {
  preset: StatusLinePreset;
  customItems: CustomStatusItem[];
  segmentOptions: StatusLineSegmentOptions;
  custom: CustomLayoutConfig | null;
  mouseScroll: boolean;
  fixedEditor: boolean;
  /** Render the status bar below the editor instead of above it (fixed-editor mode). */
  statusBelowPrompt: boolean;
  /** Render the last-prompt rows above the editor instead of below (fixed-editor mode). */
  lastPromptAboveInput: boolean;
  /** Merge the "Working…" indicator into the status bar line instead of a separate row. */
  inlineWorkingStatus: boolean;
  /** Reduce the "Working…" indicator to just its spinner glyph (drop the message text). */
  hideWorkingMessage: boolean;
  /** Render each status segment as a filled pill with rounded half-circle caps. */
  pills: boolean;
  /** Hex background color used for pills when `pills` is enabled. */
  pillBackground: string;
  /** Per-segment-id hex background overrides for pills. */
  pillColors: Record<string, string>;
  /** Default text/icon color for pills (empty = keep each segment's own colors). */
  pillForeground: string;
  /** Per-segment-id hex text/icon color overrides for pills. */
  pillTextColors: Record<string, string>;
  /** Groups of segment ids to merge into a single multi-color pill. */
  pillGroups: string[][];
  /** Force the token in/out/cached segments to render even when the value is 0. */
  alwaysShowTokens: boolean;
  /** Render the status bar text in bold. */
  bold: boolean;
  /**
   * Use Nerd Font glyph icons and separators. This is the primary control.
   * `null` means "not configured": fall back to the POWERLINE_NERD_FONTS env
   * var, then default to `true`. The env var, when explicitly set, overrides this.
   */
  nerdFonts: boolean | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePreset(value: unknown, presets: readonly StatusLinePreset[]): StatusLinePreset | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (presets as readonly string[]).includes(normalized) ? (normalized as StatusLinePreset) : null;
}

function normalizeCustomItemId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return /^[a-zA-Z0-9_-]+$/.test(normalized) ? normalized : null;
}

function normalizeCustomItemPosition(value: unknown): CustomItemPosition {
  if (value === "left" || value === "right" || value === "secondary") return value;
  return "right";
}

function normalizeCustomColor(value: unknown): ColorValue | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? (normalized as ColorValue) : undefined;
}

function normalizeCustomPrefix(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = stripTerminalControlSequences(value).trim();
  return normalized ? normalized : undefined;
}

function normalizeCustomStatusItem(raw: unknown, idOverride?: string): CustomStatusItem | null {
  if (!isRecord(raw)) return null;
  const id = normalizeCustomItemId(idOverride ?? raw.id);
  if (!id) return null;

  const statusKey = typeof raw.statusKey === "string" && raw.statusKey.trim() ? raw.statusKey.trim() : id;

  return {
    id,
    statusKey,
    position: normalizeCustomItemPosition(raw.position),
    color: normalizeCustomColor(raw.color),
    prefix: normalizeCustomPrefix(raw.prefix),
    hideWhenMissing: raw.hideWhenMissing !== false,
    excludeFromExtensionStatuses: raw.excludeFromExtensionStatuses !== false,
  };
}

function normalizeCustomItems(raw: unknown): CustomStatusItem[] {
  const normalized: CustomStatusItem[] = [];

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const item = normalizeCustomStatusItem(entry);
      if (item) normalized.push(item);
    }
  } else if (isRecord(raw)) {
    for (const [id, entry] of Object.entries(raw)) {
      const item = normalizeCustomStatusItem(entry, id);
      if (item) normalized.push(item);
    }
  }

  const deduped = new Map<string, CustomStatusItem>();
  for (const item of normalized) {
    deduped.set(item.id, item);
  }

  return [...deduped.values()];
}

function isBuiltinSegmentId(value: unknown): value is BuiltinStatusLineSegmentId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BUILTIN_SEGMENT_ID_SET, value);
}

function normalizeSegmentIdList(raw: unknown): BuiltinStatusLineSegmentId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<BuiltinStatusLineSegmentId>();
  for (const entry of raw) {
    if (isBuiltinSegmentId(entry)) seen.add(entry);
  }
  return [...seen];
}

// Parse `powerline.custom` into a validated layout. Unknown segment ids and
// invalid separators are dropped. Returns null when nothing usable is present.
function normalizeCustomLayout(raw: unknown): CustomLayoutConfig | null {
  if (!isRecord(raw)) return null;

  const layout: CustomLayoutConfig = {};
  const left = normalizeSegmentIdList(raw.leftSegments);
  const right = normalizeSegmentIdList(raw.rightSegments);
  const secondary = normalizeSegmentIdList(raw.secondarySegments);

  if (left) layout.leftSegments = left;
  if (right) layout.rightSegments = right;
  if (secondary) layout.secondarySegments = secondary;
  if (isSeparatorStyle(raw.separator)) layout.separator = raw.separator;

  return Object.keys(layout).length > 0 ? layout : null;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const THEME_COLOR_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function normalizeColorValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return HEX_COLOR.test(normalized) || THEME_COLOR_NAME.test(normalized) ? normalized : "";
}

export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1B\][^\u0007]*(?:\u0007|\x1B\\)/g, "")
    .replace(/\x1B[P\]^_].*?\x1B\\/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

// Parse `powerline.pillColors`: an object mapping segment id -> hex color.
function normalizePillColors(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, color] of Object.entries(raw)) {
    if (typeof color === "string" && HEX_COLOR.test(color)) out[id] = color;
  }
  return out;
}

// Parse `powerline.pillGroups`: an array of arrays of segment ids.
function normalizePillGroups(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return [];
  const groups: string[][] = [];
  for (const group of raw) {
    if (!Array.isArray(group)) continue;
    const ids = group.filter((id): id is string => typeof id === "string");
    if (ids.length > 0) groups.push(ids);
  }
  return groups;
}

function normalizeSegmentOptions(raw: Record<string, unknown>): StatusLineSegmentOptions {
  const options: StatusLineSegmentOptions = {};

  if (isRecord(raw.model)) {
    options.model = {
      ...(typeof raw.model.showThinkingLevel === "boolean" ? { showThinkingLevel: raw.model.showThinkingLevel } : {}),
    };
  }

  if (isRecord(raw.path)) {
    options.path = {
      ...(raw.path.mode === "basename" || raw.path.mode === "abbreviated" || raw.path.mode === "full" ? { mode: raw.path.mode } : {}),
      ...(typeof raw.path.maxLength === "number" && Number.isFinite(raw.path.maxLength) && raw.path.maxLength > 0
        ? { maxLength: Math.floor(raw.path.maxLength) }
        : {}),
    };
  }

  if (isRecord(raw.git)) {
    options.git = {
      ...(typeof raw.git.showBranch === "boolean" ? { showBranch: raw.git.showBranch } : {}),
      ...(typeof raw.git.showStaged === "boolean" ? { showStaged: raw.git.showStaged } : {}),
      ...(typeof raw.git.showUnstaged === "boolean" ? { showUnstaged: raw.git.showUnstaged } : {}),
      ...(typeof raw.git.showUntracked === "boolean" ? { showUntracked: raw.git.showUntracked } : {}),
      ...(raw.git.polling === "full" || raw.git.polling === "branch" || raw.git.polling === "off" ? { polling: raw.git.polling } : {}),
    };
  }

  if (isRecord(raw.time)) {
    options.time = {
      ...(raw.time.format === "12h" || raw.time.format === "24h" ? { format: raw.time.format } : {}),
      ...(typeof raw.time.showSeconds === "boolean" ? { showSeconds: raw.time.showSeconds } : {}),
    };
  }

  return options;
}

export function mergeSegmentOptions(
  defaults: StatusLineSegmentOptions = {},
  overrides: StatusLineSegmentOptions = {},
): StatusLineSegmentOptions {
  return {
    ...defaults,
    ...overrides,
    model: { ...defaults.model, ...overrides.model },
    path: { ...defaults.path, ...overrides.path },
    git: { ...defaults.git, ...overrides.git },
    time: { ...defaults.time, ...overrides.time },
  };
}

export function parsePowerlineConfig(value: unknown, presets: readonly StatusLinePreset[]): PowerlineConfig {
  const defaultConfig: PowerlineConfig = { preset: "default", customItems: [], segmentOptions: {}, custom: null, mouseScroll: true, fixedEditor: true, statusBelowPrompt: false, lastPromptAboveInput: false, inlineWorkingStatus: false, hideWorkingMessage: false, pills: false, pillBackground: DEFAULT_PILL_BACKGROUND, pillColors: {}, pillForeground: "", pillTextColors: {}, pillGroups: [], alwaysShowTokens: false, bold: false, nerdFonts: null };

  const directPreset = normalizePreset(value, presets);
  if (directPreset) return { ...defaultConfig, preset: directPreset };

  if (!isRecord(value)) return defaultConfig;

  return {
    preset: normalizePreset(value.preset, presets) ?? defaultConfig.preset,
    customItems: normalizeCustomItems(value.customItems),
    segmentOptions: normalizeSegmentOptions(value),
    custom: normalizeCustomLayout(value.custom),
    mouseScroll: value.mouseScroll !== false,
    fixedEditor: value.fixedEditor !== false,
    statusBelowPrompt: value.statusBelowPrompt === true,
    lastPromptAboveInput: value.lastPromptAboveInput === true,
    inlineWorkingStatus: value.inlineWorkingStatus === true,
    hideWorkingMessage: value.hideWorkingMessage === true,
    pills: value.pills === true,
    pillBackground: typeof value.pillBackground === "string" && /^#[0-9a-fA-F]{6}$/.test(value.pillBackground)
      ? value.pillBackground
      : DEFAULT_PILL_BACKGROUND,
    pillColors: normalizePillColors(value.pillColors),
    pillForeground: normalizeColorValue(value.pillForeground),
    pillTextColors: normalizePillColors(value.pillTextColors),
    pillGroups: normalizePillGroups(value.pillGroups),
    alwaysShowTokens: value.alwaysShowTokens === true,
    bold: value.bold === true,
    nerdFonts: typeof value.nerdFonts === "boolean" ? value.nerdFonts : null,
  };
}

// When the active preset is `custom` and a `powerline.custom` layout is
// configured, override the preset's segments/separator with the user's values.
// Any field omitted from the config falls back to the built-in `custom` preset.
export function applyCustomLayout(presetDef: PresetDef, config: Pick<PowerlineConfig, "preset" | "custom">): PresetDef {
  if (config.preset !== "custom" || !config.custom) return presetDef;
  const custom = config.custom;
  return {
    ...presetDef,
    leftSegments: custom.leftSegments ?? presetDef.leftSegments,
    rightSegments: custom.rightSegments ?? presetDef.rightSegments,
    secondarySegments: custom.secondarySegments ?? presetDef.secondarySegments,
    separator: custom.separator ?? presetDef.separator,
  };
}

export function mergeSegmentsWithCustomItems(presetDef: PresetDef, customItems: readonly CustomStatusItem[]): {
  leftSegments: StatusLineSegmentId[];
  rightSegments: StatusLineSegmentId[];
  secondarySegments: StatusLineSegmentId[];
} {
  const left: StatusLineSegmentId[] = [...presetDef.leftSegments];
  const right: StatusLineSegmentId[] = [...presetDef.rightSegments];
  const secondary: StatusLineSegmentId[] = [...(presetDef.secondarySegments ?? [])];

  for (const item of customItems) {
    const segmentId: StatusLineSegmentId = `custom:${item.id}`;
    if (item.position === "left") left.push(segmentId);
    else if (item.position === "secondary") secondary.push(segmentId);
    else right.push(segmentId);
  }

  return { leftSegments: left, rightSegments: right, secondarySegments: secondary };
}

export function nextPowerlineSettingWithPreset(existingPowerlineSetting: unknown, preset: StatusLinePreset): unknown {
  if (!isRecord(existingPowerlineSetting)) {
    return preset;
  }
  return { ...existingPowerlineSetting, preset };
}

export function nextPowerlineSettingWithOptions(
  existingPowerlineSetting: unknown,
  updates: Partial<Pick<PowerlineConfig, "mouseScroll" | "fixedEditor">>,
  currentPreset: StatusLinePreset,
): unknown {
  if (!isRecord(existingPowerlineSetting)) {
    return { preset: currentPreset, ...updates };
  }
  return { ...existingPowerlineSetting, ...updates };
}

export function collectHiddenExtensionStatusKeys(customItems: readonly CustomStatusItem[]): Set<string> {
  const hidden = new Set<string>();
  for (const item of customItems) {
    if (item.excludeFromExtensionStatuses) hidden.add(item.statusKey);
  }
  return hidden;
}

export function isNotificationExtensionStatus(value: string): boolean {
  return stripTerminalControlSequences(value).trimStart().startsWith("[");
}

export function getNotificationExtensionStatuses(
  statuses: ReadonlyMap<string, string>,
  hiddenKeys: ReadonlySet<string>,
): string[] {
  const notifications: string[] = [];
  for (const [statusKey, value] of statuses.entries()) {
    if (hiddenKeys.has(statusKey) || !value || !isNotificationExtensionStatus(value)) {
      continue;
    }
    const normalized = normalizeExtensionStatusValue(value);
    if (normalized) notifications.push(normalized);
  }
  return notifications;
}

export function normalizeExtensionStatusValue(value: string): string | null {
  if (!value || visibleWidth(value) <= 0) {
    return null;
  }

  const stripped = stripTerminalControlSequences(value).replace(/(\s|·|[|])+$/, "");
  return visibleWidth(stripped) > 0 ? stripped : null;
}

export function normalizeCompactExtensionStatus(value: string): string | null {
  if (isNotificationExtensionStatus(value)) {
    return null;
  }

  return normalizeExtensionStatusValue(value);
}
