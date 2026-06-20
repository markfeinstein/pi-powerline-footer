import { fileURLToPath } from "node:url";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { matchesConfiguredShortcut } from "../shortcuts.ts";
import { stripTerminalControlSequences } from "../sanitize.ts";
import { getOneOffBashCommandContext } from "./completion.ts";
import type { GhostSuggestion } from "./types.ts";

interface EditorBoundaryShortcuts {
  start: string;
  end: string;
}

interface BashModeEditorOptions {
  keybindings: KeybindingsManager;
  isBashModeActive: () => boolean;
  isShellRunning: () => boolean;
  onExitBashMode: () => void;
  onSubmitCommand: (command: string) => void;
  onEditorSubmit?: () => void;
  editorBoundaryShortcuts?: EditorBoundaryShortcuts;
  onInterrupt: () => void;
  onNotify: (message: string, level?: "info" | "warning" | "error") => void;
  getHistoryEntries: (prefix: string) => string[];
  resolveGhostSuggestion: (text: string, signal: AbortSignal) => Promise<GhostSuggestion | null>;
}

const DEFAULT_EDITOR_BOUNDARY_SHORTCUTS: EditorBoundaryShortcuts = {
  start: "super+shift+up",
  end: "super+shift+down",
};

function isPrintableInput(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 32;
}

function shouldSanitizeDirectInput(data: string): boolean {
  return data.length > 0 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 0x7f;
}

function sanitizeGhostValue(value: string): string {
  return stripTerminalControlSequences(value).replace(/[\r\n\t]/g, " ");
}

function sanitizeEditorRecallValue(value: string): string {
  return stripTerminalControlSequences(value);
}

function escapeShellPath(value: string): string {
  return value.replace(/([\\\s"'`$&|;<>()[\]{}?!*#])/g, "\\$1");
}

function escapeDroppedPathText(value: string): string {
  // Finder/terminal drops sometimes arrive already shell-escaped (notably
  // spaces as `\ `). Normalize those known shell escapes before escaping so a
  // bash-mode drop still points at the same path instead of double-escaping.
  const unescapedExistingShellEscapes = value.replace(/\\([\\\s"'`$&|;<>()[\]{}?!*#])/g, "$1");
  return escapeShellPath(unescapedExistingShellEscapes);
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

type TerminalControlState = "normal" | "escape" | "csi" | "osc" | "string" | "oscEscape" | "stringEscape";

function stripStreamingEditorControlSequences(value: string, initialState: TerminalControlState): { text: string; state: TerminalControlState } {
  let state = initialState;
  let text = "";

  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    const code = char.charCodeAt(0);

    if (state === "oscEscape" || state === "stringEscape") {
      const resumedState = state === "oscEscape" ? "osc" : "string";
      if (char === "\\") {
        state = "normal";
        continue;
      }
      state = resumedState;
      i -= 1;
      continue;
    }

    if (state === "osc") {
      if (char === "\u0007" || char === "\u009c") {
        state = "normal";
      } else if (char === "\x1b") {
        if (value[i + 1] === "\\") {
          state = "normal";
          i += 1;
        } else if (i + 1 >= value.length) {
          state = "oscEscape";
        }
      }
      continue;
    }

    if (state === "string") {
      if (char === "\u009c") {
        state = "normal";
      } else if (char === "\x1b") {
        if (value[i + 1] === "\\") {
          state = "normal";
          i += 1;
        } else if (i + 1 >= value.length) {
          state = "stringEscape";
        }
      }
      continue;
    }

    if (state === "csi") {
      if (code >= 0x40 && code <= 0x7e) state = "normal";
      continue;
    }

    if (state === "escape") {
      if (char === "[") state = "csi";
      else if (char === "]") state = "osc";
      else if (char === "P" || char === "X" || char === "^" || char === "_") state = "string";
      else state = "normal";
      continue;
    }

    if (char === "\x1b") {
      state = "escape";
      continue;
    }
    if (char === "\u009b") {
      state = "csi";
      continue;
    }
    if (char === "\u009d") {
      state = "osc";
      continue;
    }
    if (char === "\u0090" || char === "\u0098" || char === "\u009e" || char === "\u009f") {
      state = "string";
      continue;
    }
    if ((code >= 0x00 && code <= 0x08) || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      continue;
    }
    text += char;
  }

  return { text, state };
}

function isCommandUndoShortcut(data: string): boolean {
  return data === "\x1b[122;9u"
    || data === "\x1b[122;9:1u"
    || data === "\x1b[122;9:2u"
    || data === "\x1b[27;9;122~";
}

function bracketedPasteContent(data: string): string | null {
  const startMarker = BRACKETED_PASTE_START;
  const endMarker = BRACKETED_PASTE_END;
  const start = data.indexOf(startMarker);
  if (start !== 0) return null;

  const end = data.indexOf(endMarker, startMarker.length);
  if (end === -1 || end + endMarker.length !== data.length) return null;

  return data.slice(startMarker.length, end);
}

function isPartialBracketedPasteStart(value: string): boolean {
  return value.length > 1 && value.length < BRACKETED_PASTE_START.length && BRACKETED_PASTE_START.startsWith(value);
}

function trailingBracketedPasteEndPrefixLength(value: string): number {
  const max = Math.min(value.length, BRACKETED_PASTE_END.length - 1);
  for (let length = max; length > 0; length--) {
    if (BRACKETED_PASTE_END.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

function decodeFileUriList(text: string, options: { shellEscape?: boolean } = {}): string | null {
  const entries = text
    .split(/\r?\n|\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"));

  if (entries.length === 0 || entries.some((entry) => !entry.startsWith("file://"))) {
    return null;
  }

  try {
    return entries
      .map((entry) => sanitizeEditorRecallValue(fileURLToPath(entry)))
      .map((entry) => options.shellEscape ? escapeShellPath(entry) : entry)
      .join(" ");
  } catch {
    return null;
  }
}

export function droppedPathTextFromInput(data: string, options: { shellEscape?: boolean } = {}): string | null {
  const pasteContent = bracketedPasteContent(data);
  const text = pasteContent ?? data;
  const uriList = decodeFileUriList(text, options);
  if (uriList) return sanitizeEditorRecallValue(uriList).replace(/[\r\n\t]/g, " ");

  const sanitizedText = sanitizeEditorRecallValue(text);
  const trimmed = sanitizedText.replace(/^[\r\n]+|[\r\n]+$/g, "");
  if (trimmed.length <= 1 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) {
    return null;
  }

  if (/^(?:\/|~\/|\.\.?\/)/.test(trimmed) && !/[\r\n]/.test(trimmed)) {
    return options.shellEscape ? escapeDroppedPathText(trimmed) : trimmed;
  }

  return null;
}

export class BashModeEditor extends CustomEditor {
  private readonly keybindingsRef: KeybindingsManager;
  private readonly optionsRef: BashModeEditorOptions;
  private wrappedProviderInstalled = false;
  private shellHistoryIndex = -1;
  private shellHistoryItems: string[] = [];
  private shellHistoryDraft = "";
  private promptHistoryDraft: string | null = null;
  private pendingBracketedPasteInput = "";
  private pasteControlState: TerminalControlState = "normal";
  private ghost: GhostSuggestion | null = null;
  private ghostAbort: AbortController | null = null;
  private ghostToken = 0;

  constructor(tui: any, theme: any, keybindings: KeybindingsManager, options: BashModeEditorOptions) {
    super(tui, theme, keybindings);
    this.keybindingsRef = keybindings;
    this.optionsRef = options;
  }

  installAutocompleteProvider(provider: AutocompleteProvider): void {
    this.setAutocompleteProvider(provider);
    this.wrappedProviderInstalled = true;
  }

  hasWrappedProvider(): boolean {
    return this.wrappedProviderInstalled;
  }

  getGhostSuggestion(): GhostSuggestion | null {
    return this.isShellCompletionContext() ? this.ghost : null;
  }

  refreshGhostSuggestion(): void {
    this.scheduleGhostUpdate();
  }

  clearGhostSuggestion(): void {
    this.ghostAbort?.abort();
    this.ghostAbort = null;
    this.ghost = null;
  }

  dismissBashModeUi(): void {
    this.shellHistoryIndex = -1;
    this.shellHistoryItems = [];
    this.shellHistoryDraft = "";
    this.clearGhostSuggestion();

    if ("cancelAutocomplete" in this && typeof this.cancelAutocomplete === "function") {
      this.cancelAutocomplete();
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.pendingBracketedPasteInput) {
      data = `${this.pendingBracketedPasteInput}${data}`;
      this.pendingBracketedPasteInput = "";
    }
    if (isPartialBracketedPasteStart(data)) {
      this.pendingBracketedPasteInput = data;
      return;
    }

    const shellCompletionContext = typeof this.isShellCompletionContext === "function"
      ? this.isShellCompletionContext()
      : this.optionsRef.isBashModeActive();
    const droppedPathText = droppedPathTextFromInput(data, { shellEscape: shellCompletionContext });
    if (droppedPathText !== null) {
      this.insertTextAtCursor(droppedPathText);
      this.shellHistoryIndex = -1;
      this.shellHistoryItems = [];
      this.shellHistoryDraft = "";
      if (this.isShellCompletionContext()) {
        this.scheduleGhostUpdate();
      } else {
        this.clearGhostSuggestion();
      }
      return;
    }

    const pasteContent = bracketedPasteContent(data);
    const pasteInProgress = data.includes(BRACKETED_PASTE_START) || Reflect.get(this, "isInPaste") === true;
    if (pasteInProgress) {
      const sanitizeBracketedPaste = Reflect.get(this, "sanitizeBracketedPasteInput");
      const sanitizePaste = Reflect.get(this, "sanitizePastePayload");
      const input = (typeof sanitizeBracketedPaste === "function"
        ? sanitizeBracketedPaste.call(this, data, Reflect.get(this, "isInPaste") === true)
        : null)
        ?? (pasteContent !== null
          ? `${BRACKETED_PASTE_START}${typeof sanitizePaste === "function" ? sanitizePaste.call(this, pasteContent, true) : sanitizeEditorRecallValue(pasteContent)}${BRACKETED_PASTE_END}`
          : sanitizeEditorRecallValue(data));
      if (input) super.handleInput(input);
      if (Reflect.get(this, "isInPaste") === true) {
        return;
      }
    } else {
      const bashMode = this.optionsRef.isBashModeActive();
      const oneOffBashCommand = !bashMode && this.isOneOffBashCommandContext();

      if (isCommandUndoShortcut(data)) {
        this.undo();
        this.shellHistoryIndex = -1;
        this.shellHistoryItems = [];
        this.shellHistoryDraft = "";
        if (this.isShellCompletionContext()) {
          this.scheduleGhostUpdate();
        } else {
          this.clearGhostSuggestion();
        }
        return;
      }

      if (bashMode && this.keybindingsRef.matches(data, "app.interrupt")) {
        this.optionsRef.onExitBashMode();
        return;
      }

      if (bashMode && this.keybindingsRef.matches(data, "app.clear") && this.optionsRef.isShellRunning()) {
        this.optionsRef.onInterrupt();
        return;
      }

      if (bashMode && this.keybindingsRef.matches(data, "tui.editor.cursorUp")) {
        this.navigateShellHistory(-1);
        return;
      }

      if (bashMode && this.keybindingsRef.matches(data, "tui.editor.cursorDown")) {
        this.navigateShellHistory(1);
        return;
      }

      const editorBoundaryShortcuts = this.optionsRef.editorBoundaryShortcuts ?? DEFAULT_EDITOR_BOUNDARY_SHORTCUTS;
      if (!isKeyRelease(data) && matchesConfiguredShortcut(data, editorBoundaryShortcuts.start)) {
        this.moveCursorToEditorBoundary("start");
        return;
      }

      if (!isKeyRelease(data) && matchesConfiguredShortcut(data, editorBoundaryShortcuts.end)) {
        this.moveCursorToEditorBoundary("end");
        return;
      }

      if ((bashMode || oneOffBashCommand) && this.keybindingsRef.matches(data, "tui.input.tab")) {
        this.acceptGhostSuggestion();
        return;
      }

      if (
        (bashMode || oneOffBashCommand)
        && this.keybindingsRef.matches(data, "tui.editor.cursorRight")
        && this.acceptGhostSuggestion()
      ) {
        return;
      }

      if (!bashMode && this.keybindingsRef.matches(data, "tui.editor.cursorUp") && this.isPromptHistoryRecallPosition()) {
        const navigateHistory = Reflect.get(this, "navigateHistory");
        if (typeof navigateHistory === "function") {
          if (Reflect.get(this, "historyIndex") === -1) {
            this.promptHistoryDraft = this.getText();
          }
          navigateHistory.call(this, -1);
          this.setTextFromRecall(this.getText());
          return;
        }
      }

      if (!bashMode && this.keybindingsRef.matches(data, "tui.editor.cursorUp") && !this.isShowingAutocomplete()) {
        const history = Reflect.get(this, "history");
        const historyIndex = Reflect.get(this, "historyIndex");
        const isOnFirstVisualLine = Reflect.get(this, "isOnFirstVisualLine");
        const moveToLineStart = Reflect.get(this, "moveToLineStart");
        if (
          historyIndex === -1
          &&
          Array.isArray(history)
          && history.length > 0
          && typeof isOnFirstVisualLine === "function"
          && isOnFirstVisualLine.call(this)
          && typeof moveToLineStart === "function"
        ) {
          moveToLineStart.call(this);
          return;
        }
      }

      if (!bashMode && this.keybindingsRef.matches(data, "tui.editor.cursorDown") && Reflect.get(this, "historyIndex") > -1) {
        const isOnLastVisualLine = Reflect.get(this, "isOnLastVisualLine");
        if (typeof isOnLastVisualLine !== "function" || isOnLastVisualLine.call(this)) {
          const navigateHistory = Reflect.get(this, "navigateHistory");
          if (typeof navigateHistory === "function") {
            navigateHistory.call(this, 1);
            this.setTextFromRecall(this.getText());
            if (Reflect.get(this, "historyIndex") === -1 && this.promptHistoryDraft !== null) {
              const draft = sanitizeEditorRecallValue(this.promptHistoryDraft);
              this.promptHistoryDraft = null;
              this.setTextFromRecall(draft);
            }
            return;
          }
        }
      }

      if (bashMode && this.keybindingsRef.matches(data, "tui.input.submit") && !this.keybindingsRef.matches(data, "tui.input.newLine")) {
        if (this.optionsRef.isShellRunning()) {
          this.optionsRef.onNotify("Shell command already running", "warning");
          return;
        }

        const command = this.getExpandedText().trim();
        if (!command) return;
        this.clearGhostSuggestion();
        this.shellHistoryIndex = -1;
        this.shellHistoryItems = [];
        this.shellHistoryDraft = "";
        this.optionsRef.onEditorSubmit?.();
        this.optionsRef.onSubmitCommand(command);
        this.setText("");
        this.refreshGhostSuggestion();
        return;
      }

      const input = shouldSanitizeDirectInput(data) ? sanitizeEditorRecallValue(data) : data;
      if (input) super.handleInput(input);
    }

    if (!this.isShellCompletionContext()) {
      this.shellHistoryIndex = -1;
      this.shellHistoryItems = [];
      this.shellHistoryDraft = "";
      this.clearGhostSuggestion();
      return;
    }

    if (
      pasteInProgress
      ||
      isPrintableInput(data)
      || this.keybindingsRef.matches(data, "tui.editor.deleteCharBackward")
      || this.keybindingsRef.matches(data, "tui.editor.deleteCharForward")
      || this.keybindingsRef.matches(data, "tui.editor.deleteWordBackward")
      || this.keybindingsRef.matches(data, "tui.editor.deleteWordForward")
      || this.keybindingsRef.matches(data, "tui.editor.deleteToLineStart")
      || this.keybindingsRef.matches(data, "tui.editor.deleteToLineEnd")
      || this.keybindingsRef.matches(data, "tui.input.newLine")
      || this.keybindingsRef.matches(data, "tui.editor.cursorLeft")
      || this.keybindingsRef.matches(data, "tui.editor.cursorRight")
    ) {
      this.shellHistoryIndex = -1;
      this.shellHistoryItems = [];
      this.shellHistoryDraft = "";
      this.scheduleGhostUpdate();
    }
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.isShellCompletionContext()) return lines;
    if (!this.ghost) return lines;

    const text = this.getText();
    if (text.includes("\n")) return lines;
    const cursor = this.getCursor();
    if (cursor.line !== 0 || cursor.col !== text.length) return lines;
    const ghostValue = sanitizeGhostValue(this.ghost.value);
    if (!ghostValue.startsWith(text) || ghostValue === text) return lines;
    if (lines.length < 3) return lines;

    const suffix = ghostValue.slice(text.length);
    const contentLine = 1;
    const cursorBlock = "\x1b[7m \x1b[0m";
    const availableWidth = Math.max(0, width - visibleWidth(text) - 1);
    if (availableWidth === 0) return lines;

    const shownSuffix = truncateToWidth(suffix, availableWidth, "", true);
    if (!shownSuffix) return lines;

    const padding = " ".repeat(Math.max(0, width - visibleWidth(text) - 1 - visibleWidth(shownSuffix)));
    const ghost = `\x1b[38;5;244m${shownSuffix}\x1b[0m`;
    lines[contentLine] = `${text}${cursorBlock}${ghost}${padding}`;
    return lines;
  }

  private sanitizePastePayload(value: string, reset = false): string {
    if (reset) this.pasteControlState = "normal";
    const stripped = stripStreamingEditorControlSequences(value, this.pasteControlState);
    this.pasteControlState = stripped.state;
    return stripped.text;
  }

  private sanitizeBracketedPasteInput(data: string, inPaste: boolean): string | null {
    if (data.startsWith(BRACKETED_PASTE_START)) {
      const payloadStart = BRACKETED_PASTE_START.length;
      const end = data.indexOf(BRACKETED_PASTE_END, payloadStart);
      if (end === -1) {
        return `${BRACKETED_PASTE_START}${this.sanitizePastePayload(data.slice(payloadStart), true)}`;
      }
      const payload = this.sanitizePastePayload(data.slice(payloadStart, end), true);
      this.pasteControlState = "normal";
      return `${BRACKETED_PASTE_START}${payload}${BRACKETED_PASTE_END}${sanitizeEditorRecallValue(data.slice(end + BRACKETED_PASTE_END.length))}`;
    }

    if (!inPaste) return null;
    const end = data.indexOf(BRACKETED_PASTE_END);
    if (end === -1) {
      const tailLength = trailingBracketedPasteEndPrefixLength(data);
      if (tailLength === 0) return this.sanitizePastePayload(data);
      return `${this.sanitizePastePayload(data.slice(0, -tailLength))}${data.slice(-tailLength)}`;
    }
    const payload = this.sanitizePastePayload(data.slice(0, end));
    this.pasteControlState = "normal";
    return `${payload}${BRACKETED_PASTE_END}${sanitizeEditorRecallValue(data.slice(end + BRACKETED_PASTE_END.length))}`;
  }

  private isShellCompletionContext(): boolean {
    return this.optionsRef.isBashModeActive() || this.isOneOffBashCommandContext();
  }

  private isOneOffBashCommandContext(): boolean {
    return getOneOffBashCommandContext(this.getExpandedText()) !== null;
  }

  private moveCursorToEditorBoundary(position: "start" | "end"): void {
    const state = Reflect.get(this, "state");
    const lines = state && typeof state === "object" ? Reflect.get(state, "lines") : null;
    if (!Array.isArray(lines)) {
      this.optionsRef.onNotify("Editor cursor state is unavailable", "warning");
      return;
    }

    if (position === "start") {
      Reflect.set(state, "cursorLine", 0);
      Reflect.set(state, "cursorCol", 0);
    } else {
      const lastLine = Math.max(0, lines.length - 1);
      Reflect.set(state, "cursorLine", lastLine);
      Reflect.set(state, "cursorCol", typeof lines[lastLine] === "string" ? lines[lastLine].length : 0);
    }

    Reflect.set(this, "lastAction", null);
    Reflect.set(this, "preferredVisualCol", null);
    Reflect.set(this, "snappedFromCursorCol", null);
    this.tui.requestRender();
  }

  private acceptGhostSuggestion(): boolean {
    if (!this.ghost) return false;
    const text = this.getExpandedText();
    if (text.includes("\n")) return false;

    const cursor = this.getCursor();
    if (cursor.line !== 0 || cursor.col !== text.length) return false;

    const ghostValue = sanitizeGhostValue(this.ghost.value);
    if (!ghostValue.startsWith(text) || ghostValue === text) return false;
    this.setText(ghostValue);
    this.clearGhostSuggestion();
    return true;
  }

  private setTextFromRecall(value: string): void {
    const sanitized = sanitizeEditorRecallValue(value);
    const setTextInternal = Reflect.get(this, "setTextInternal");
    if (typeof setTextInternal === "function") {
      setTextInternal.call(this, sanitized);
    } else {
      this.setText(sanitized);
    }
  }

  private isPromptHistoryRecallPosition(): boolean {
    if (this.isShowingAutocomplete()) return false;

    const history = Reflect.get(this, "history");
    if (!Array.isArray(history) || history.length === 0) return false;

    const lines = this.getLines();
    const cursor = this.getCursor();
    const lastLine = Math.max(0, lines.length - 1);
    return cursor.line === lastLine && cursor.col === (lines[lastLine]?.length ?? 0);
  }

  private navigateShellHistory(direction: -1 | 1): void {
    const prefix = this.shellHistoryDraft || this.getExpandedText();
    if (this.shellHistoryIndex === -1) {
      this.shellHistoryDraft = prefix;
      this.shellHistoryItems = this.optionsRef.getHistoryEntries(prefix).map(sanitizeEditorRecallValue);
    }

    if (this.shellHistoryItems.length === 0) {
      this.optionsRef.onNotify("No shell history matches", "info");
      return;
    }

    if (direction < 0) {
      this.shellHistoryIndex = Math.min(this.shellHistoryItems.length - 1, this.shellHistoryIndex + 1);
      this.setText(sanitizeEditorRecallValue(this.shellHistoryItems[this.shellHistoryIndex] ?? this.shellHistoryDraft));
      this.clearGhostSuggestion();
      return;
    }

    this.shellHistoryIndex -= 1;
    if (this.shellHistoryIndex < 0) {
      this.shellHistoryIndex = -1;
      this.setText(sanitizeEditorRecallValue(this.shellHistoryDraft));
      this.scheduleGhostUpdate();
      return;
    }

    this.setText(sanitizeEditorRecallValue(this.shellHistoryItems[this.shellHistoryIndex] ?? this.shellHistoryDraft));
    this.clearGhostSuggestion();
  }

  private scheduleGhostUpdate(): void {
    const text = this.getExpandedText();
    const currentToken = ++this.ghostToken;
    this.ghostAbort?.abort();

    const controller = new AbortController();
    this.ghostAbort = controller;
    this.optionsRef.resolveGhostSuggestion(text, controller.signal)
      .then((ghost) => {
        if (controller.signal.aborted || currentToken !== this.ghostToken) return;
        this.ghost = ghost ? { ...ghost, value: sanitizeGhostValue(ghost.value) } : null;
        this.tui.requestRender();
      })
      .catch((error) => {
        if (error instanceof Error && error.message === "aborted") return;
        console.debug("[powerline-footer] Failed to resolve bash ghost suggestion:", error);
      });
  }
}
