import { stripTerminalControlSequences } from "../sanitize.ts";
import type { BashCommandRecord, BashModeSettings, BashTranscriptSnapshot } from "./types.ts";

export const BASH_TRANSCRIPT_MAX_LINES = 10_000;
export const BASH_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

function capTranscriptLimit(value: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.floor(value), max) : max;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function compactLines(lines: string[]): string[] {
  const normalized: string[] = [];
  for (const line of lines) {
    const sanitized = stripTerminalControlSequences(line).replace(/\r/g, "");
    if (sanitized.length === 0) {
      normalized.push("");
      continue;
    }
    normalized.push(...sanitized.split("\n"));
  }
  return normalized;
}

function trimStartToMaxBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;

  // Keep the longest suffix that fits within maxBytes. Count UTF-8 bytes per code
  // point and only break on code-point boundaries so astral chars (emoji) are
  // never split into a lone surrogate (which would render as �). Walking the byte
  // budget directly avoids the prior bug where a byte count was used as a UTF-16
  // code-unit slice offset, which over-trimmed multibyte text to an empty string.
  const chars = Array.from(value);
  let bytes = 0;
  let startChar = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const charBytes = byteLength(chars[i]!);
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    startChar = i;
  }

  return chars.slice(startChar).join("");
}

export class BashTranscriptStore {
  private readonly settings: Pick<BashModeSettings, "transcriptMaxLines" | "transcriptMaxBytes">;
  private commands: BashCommandRecord[] = [];
  private commandIndex = new Map<string, BashCommandRecord>();
  private totalLines = 0;
  private totalBytes = 0;
  private truncatedCommands = 0;

  constructor(settings: Pick<BashModeSettings, "transcriptMaxLines" | "transcriptMaxBytes">) {
    this.settings = {
      transcriptMaxLines: capTranscriptLimit(settings.transcriptMaxLines, BASH_TRANSCRIPT_MAX_LINES),
      transcriptMaxBytes: capTranscriptLimit(settings.transcriptMaxBytes, BASH_TRANSCRIPT_MAX_BYTES),
    };
  }

  startCommand(id: string, command: string, cwdAtStart: string): BashCommandRecord {
    const entry: BashCommandRecord = {
      id,
      command: stripTerminalControlSequences(command),
      cwdAtStart: stripTerminalControlSequences(cwdAtStart),
      startedAt: Date.now(),
      output: [],
      outputBytes: 0,
      exitCode: null,
      finishedAt: null,
      truncated: false,
    };

    this.commands.push(entry);
    this.commandIndex.set(id, entry);
    this.enforceLimits();
    return entry;
  }

  appendOutput(id: string, chunk: string): void {
    const entry = this.commandIndex.get(id);
    if (!entry || !chunk) return;

    const lines = compactLines([chunk]);
    if (lines.length === 0) return;

    entry.output.push(...lines);
    const addedBytes = lines.reduce((sum, line) => sum + byteLength(line) + 1, 0);
    entry.outputBytes += addedBytes;
    this.totalLines += lines.length;
    this.totalBytes += addedBytes;
    this.enforceLimits();
  }

  finishCommand(id: string, exitCode: number): void {
    const entry = this.commandIndex.get(id);
    if (!entry) return;

    entry.exitCode = exitCode;
    entry.finishedAt = Date.now();
  }

  clear(): void {
    this.commands = [];
    this.commandIndex.clear();
    this.totalLines = 0;
    this.totalBytes = 0;
    this.truncatedCommands = 0;
  }

  getSnapshot(): BashTranscriptSnapshot {
    return {
      commands: this.commands.map((command) => ({
        ...command,
        output: [...command.output],
      })),
      totalLines: this.totalLines,
      totalBytes: this.totalBytes,
      truncatedCommands: this.truncatedCommands,
    };
  }

  private enforceLimits(): void {
    while (
      this.commands.length > 1
      && (this.totalLines > this.settings.transcriptMaxLines || this.totalBytes > this.settings.transcriptMaxBytes)
    ) {
      const removed = this.commands.shift();
      if (!removed) break;
      this.commandIndex.delete(removed.id);
      this.totalLines = Math.max(0, this.totalLines - removed.output.length);
      this.totalBytes = Math.max(0, this.totalBytes - removed.outputBytes);
      this.truncatedCommands += 1;
      removed.truncated = true;
    }

    const active = this.commands[0];
    if (!active) return;

    while (
      active.output.length > 1
      && (this.totalLines > this.settings.transcriptMaxLines || this.totalBytes > this.settings.transcriptMaxBytes)
    ) {
      const removedLine = active.output.shift();
      if (removedLine === undefined) break;
      const removedBytes = byteLength(removedLine) + 1;
      active.outputBytes = Math.max(0, active.outputBytes - removedBytes);
      this.totalLines = Math.max(0, this.totalLines - 1);
      this.totalBytes = Math.max(0, this.totalBytes - removedBytes);
      active.truncated = true;
    }

    if (active.output.length === 1 && this.totalBytes > this.settings.transcriptMaxBytes) {
      const originalLine = active.output[0] ?? "";
      const originalBytes = byteLength(originalLine) + 1;
      const trimmedLine = trimStartToMaxBytes(originalLine, Math.max(0, this.settings.transcriptMaxBytes - 1));
      const trimmedBytes = byteLength(trimmedLine) + 1;
      active.output[0] = trimmedLine;
      active.outputBytes = Math.max(0, active.outputBytes - originalBytes + trimmedBytes);
      this.totalBytes = Math.max(0, this.totalBytes - originalBytes + trimmedBytes);
      active.truncated = true;
    }
  }
}
