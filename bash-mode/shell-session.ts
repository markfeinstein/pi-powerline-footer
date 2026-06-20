import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BashTranscriptStore } from "./transcript.ts";
import type { ShellSessionState } from "./types.ts";

const READY_SENTINEL = "__PI_READY__";
const COMMAND_START_SENTINEL = "__PI_CMD_START__";
const COMMAND_DONE_SENTINEL = "__PI_CMD_DONE__";
const SENTINEL_PRINTF = "/usr/bin/printf";
const COMMAND_DONE_FILE_POLL_INTERVAL_MS = 50;
const COMMAND_DONE_FILE_SETTLE_MS = 75;
const MAX_PARTIAL_OUTPUT_BUFFER_BYTES = 64 * 1024;
const PARTIAL_OUTPUT_TRUNCATION_MARKER = "… output truncated before newline …";
const DEFAULT_READY_TIMEOUT_MS = 5000;

type TerminalControlState = "normal" | "escape" | "csi" | "osc" | "string" | "oscEscape" | "stringEscape";

function stripStreamingTerminalControlSequences(value: string, initialState: TerminalControlState): { text: string; state: TerminalControlState } {
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

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function trimStartToMaxBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;

  // Keep the longest suffix (the most recent output) that fits within maxBytes.
  // Count UTF-8 bytes per code point and only break on code-point boundaries, so
  // astral chars (emoji) are never split into a lone surrogate. Walking the byte
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

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getCloseExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === "number") {
    return code;
  }

  if (signal === "SIGINT") {
    return 130;
  }

  if (signal === "SIGTERM") {
    return 143;
  }

  if (signal === "SIGKILL") {
    return 137;
  }

  return 1;
}

function parseReadySentinel(line: string, nonce: string): { cwd: string } | null {
  const prefix = `${READY_SENTINEL}:${nonce}:`;
  if (!line.startsWith(prefix)) return null;
  return { cwd: line.slice(prefix.length) };
}

function parseCommandStartSentinel(line: string, nonce: string): { id: string; cwd: string } | null {
  const prefix = `${COMMAND_START_SENTINEL}:${nonce}:`;
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  const separatorIndex = rest.indexOf(":");
  if (separatorIndex === -1) return null;
  return {
    id: rest.slice(0, separatorIndex),
    cwd: rest.slice(separatorIndex + 1),
  };
}

function parseCommandDoneSentinel(line: string, nonce: string, sentinel = COMMAND_DONE_SENTINEL): { id: string; exitCodeText: string; cwd: string } | null {
  const prefix = `${sentinel}:${nonce}:`;
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  const idSeparatorIndex = rest.indexOf(":");
  if (idSeparatorIndex === -1) return null;
  const statusAndCwd = rest.slice(idSeparatorIndex + 1);
  const statusSeparatorIndex = statusAndCwd.indexOf(":");
  if (statusSeparatorIndex === -1) return null;
  return {
    id: rest.slice(0, idSeparatorIndex),
    exitCodeText: statusAndCwd.slice(0, statusSeparatorIndex),
    cwd: statusAndCwd.slice(statusSeparatorIndex + 1),
  };
}

function getShellInitScript(shellName: string, nonce: string): string {
  if (shellName.includes("fish")) {
    return `
builtin printf '\\033\\\\%s:%s:%s\n' '${READY_SENTINEL}' '${nonce}' "$PWD"
`;
  }

  return `
exec 4>&1
exec 9>&1
${SENTINEL_PRINTF} '\\033\\\\%s:%s:%s\n' '${READY_SENTINEL}' '${nonce}' "$PWD" >&4 2>/dev/null || true
`;
}

function getShellCommandScript(shellName: string, nonce: string, id: string, filePath: string): string {
  const quotedFilePath = quoteShellArg(filePath);

  // Keep the secret nonce out of a persistent shell function. For POSIX-style
  // shells, run a generated per-command wrapper file with stdin detached from
  // the shell control stream so user `read`/PS4 code cannot consume lifecycle
  // lines. Sentinel writes use /usr/bin/printf so user-defined shell functions
  // named `command`, `printf`, or `source` cannot suppress lifecycle markers.
  if (shellName.includes("fish")) {
    return `
${SENTINEL_PRINTF} '\\033\\\\%s:%s:%s:%s\n' '${COMMAND_START_SENTINEL}' '${nonce}' '${id}' "$PWD"
builtin source ${quotedFilePath} < /dev/null
set -l __pi_status $status
${SENTINEL_PRINTF} '\\033\\\\\n%s:%s:%s:%s:%s\n' '${COMMAND_DONE_SENTINEL}' '${nonce}' '${id}' "$__pi_status" "$PWD"
`;
  }

  return `
exec 9>&1 || true
. ${quotedFilePath} < /dev/null
`;
}

function getShellDoneFileScript(nonce: string, id: string, filePath: string): string {
  const quotedFilePath = quoteShellArg(filePath);
  return `${SENTINEL_PRINTF} '%s:%s:%s:%s:%s\\n' '${COMMAND_DONE_SENTINEL}' '${nonce}' '${id}' "$__pi_powerline_status" "$PWD" >| ${quotedFilePath} 2>/dev/null || true`;
}

export class ManagedShellSession {
  private readonly shellPath: string;
  private readonly transcript: BashTranscriptStore;
  private readonly onStateChange: () => void;
  private readonly onCommandSuccess: (command: string, cwd: string) => void;
  private readonly onCommandComplete: (command: string, cwd: string, exitCode: number) => void;
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly tempDir = mkdtempSync(join(tmpdir(), "powerline-bash-mode-"));
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stdoutControlState: TerminalControlState = "normal";
  private stderrControlState: TerminalControlState = "normal";
  private stdoutBufferTruncated = false;
  private stderrBufferTruncated = false;
  private commandCounter = 0;
  private currentCommandId: string | null = null;
  private currentCommandNonce: string | null = null;
  private currentCommandFilePath: string | null = null;
  private currentCommandDoneFilePath: string | null = null;
  private commandDoneFileTimer: ReturnType<typeof setInterval> | null = null;
  private commandDoneFileReadyAt: number | null = null;
  private readonly sentinelNonce = randomBytes(16).toString("hex");
  private readonly readyTimeoutMs: number;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  readonly state: ShellSessionState;

  constructor(
    shellPath: string,
    cwd: string,
    transcript: BashTranscriptStore,
    onStateChange: () => void,
    onCommandSuccess: (command: string, cwd: string) => void,
    options: { readyTimeoutMs?: number; onCommandComplete?: (command: string, cwd: string, exitCode: number) => void } = {},
  ) {
    this.shellPath = shellPath;
    this.transcript = transcript;
    this.onStateChange = onStateChange;
    this.onCommandSuccess = onCommandSuccess;
    this.onCommandComplete = options.onCommandComplete ?? (() => {});
    this.readyTimeoutMs = typeof options.readyTimeoutMs === "number" && Number.isFinite(options.readyTimeoutMs) && options.readyTimeoutMs > 0
      ? options.readyTimeoutMs
      : DEFAULT_READY_TIMEOUT_MS;
    const shellName = basename(shellPath).toLowerCase();
    this.state = {
      ready: false,
      running: false,
      shellPath,
      shellName,
      cwd,
      lastExitCode: null,
    };
  }

  async ensureReady(): Promise<void> {
    if (this.state.ready) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const proc = spawn(this.shellPath, [], {
      cwd: this.state.cwd,
      env: {
        ...process.env,
        DISABLE_AUTO_UPDATE: "true",
        DISABLE_UPDATE_PROMPT: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.process = proc;

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      if (this.process === proc) this.handleStdoutChunk(String(chunk));
    });
    proc.stderr.on("data", (chunk) => {
      if (this.process === proc) this.handleStderrChunk(String(chunk));
    });
    proc.on("error", (error) => {
      if (this.process !== proc) return;
      if (!this.state.ready) {
        this.clearReadyTimer();
        this.readyReject?.(error instanceof Error ? error : new Error(String(error)));
        this.readyResolve = null;
        this.readyReject = null;
        this.readyPromise = null;
      }
    });
    proc.on("close", (code, signal) => {
      if (this.process !== proc) return;
      const exitCode = getCloseExitCode(code, signal);
      this.clearReadyTimer();
      if (!this.disposed && !this.state.ready) {
        this.readyReject?.(new Error(`Shell failed to start (exit ${exitCode})`));
      }

      if (this.currentCommandId) {
        this.completeCurrentCommand(this.currentCommandId, exitCode, null, false);
      }

      this.process = null;
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.stdoutControlState = "normal";
      this.stderrControlState = "normal";
      this.stdoutBufferTruncated = false;
      this.stderrBufferTruncated = false;
      this.readyPromise = null;
      this.readyResolve = null;
      this.readyReject = null;
      this.state.ready = false;
      this.state.running = false;
      this.cleanupTempDir();
      this.onStateChange();
    });

    this.readyTimer = setTimeout(() => {
      if (this.process !== proc || this.state.ready || this.disposed) return;
      const error = new Error(`Shell did not become ready within ${this.readyTimeoutMs}ms`);
      this.readyReject?.(error);
      this.readyResolve = null;
      this.readyReject = null;
      this.readyPromise = null;
      this.killProcess("SIGKILL");
      this.onStateChange();
    }, this.readyTimeoutMs);
    if (typeof this.readyTimer === "object" && "unref" in this.readyTimer) {
      this.readyTimer.unref();
    }

    this.sendRaw(getShellInitScript(this.state.shellName, this.sentinelNonce) + "\n");
    return this.readyPromise;
  }

  async runCommand(command: string): Promise<void> {
    await this.ensureReady();
    if (!this.process) {
      throw new Error("Shell process not available");
    }
    if (this.state.running) {
      throw new Error("Shell command already running");
    }

    const id = `cmd-${++this.commandCounter}`;
    const extension = this.state.shellName.includes("fish") ? "fish" : "sh";
    const filePath = join(this.tempDir, `${id}.${extension}`);
    const doneFilePath = join(this.tempDir, `${id}.done`);
    const commandNonce = randomBytes(16).toString("hex");
    mkdirSync(this.tempDir, { recursive: true });
    const commandScript = command.endsWith("\n") ? command : `${command}\n`;
    const startSentinel = `if exec 4>&9 2>/dev/null; then ${SENTINEL_PRINTF} '\\033\\\\%s:%s:%s:%s\\n' '${COMMAND_START_SENTINEL}' '${commandNonce}' '${id}' "$PWD" >&4 2>/dev/null || true; fi`;
    const doneSentinel = `if exec 4>&9 2>/dev/null; then ${SENTINEL_PRINTF} '\\033\\\\\\n%s:%s:%s:%s:%s\\n' '${COMMAND_DONE_SENTINEL}' '${commandNonce}' '${id}' "$__pi_powerline_status" "$PWD" >&4 2>/dev/null || true; fi`;
    const doneFileSentinel = getShellDoneFileScript(commandNonce, id, doneFilePath);
    const script = this.state.shellName.includes("fish")
      ? commandScript
      : `(set +x; ${startSentinel}) 2>/dev/null\n__pi_powerline_run() {\n${commandScript}}\n__pi_powerline_run\n__pi_powerline_status=$?\nset +x\ntrap - DEBUG RETURN ERR EXIT 2>/dev/null || true\nunset -f __pi_powerline_run 2>/dev/null || true\n(set +x; ${doneFileSentinel}) 2>/dev/null\n(set +x; ${doneSentinel}) 2>/dev/null\nreturn "$__pi_powerline_status"\n`;
    writeFileSync(filePath, script, { encoding: "utf8", mode: 0o600 });
    chmodSync(filePath, 0o600);

    this.stdoutControlState = "normal";
    this.stderrControlState = "normal";
    this.currentCommandId = id;
    this.currentCommandNonce = commandNonce;
    this.currentCommandFilePath = filePath;
    this.currentCommandDoneFilePath = this.state.shellName.includes("fish") ? null : doneFilePath;
    this.stdoutBufferTruncated = false;
    this.stderrBufferTruncated = false;
    this.state.running = true;
    this.transcript.startCommand(id, command, this.state.cwd);
    this.onStateChange();
    this.startCommandDoneFileWatcher();
    this.sendRaw(getShellCommandScript(this.state.shellName, commandNonce, id, filePath));
  }

  interrupt(): void {
    if (!this.process || !this.state.running) return;
    this.killProcess("SIGINT");
  }

  dispose(): void {
    this.disposed = true;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.clearCommandDoneFileWatcher();
    if (!this.process) {
      this.cleanupTempDir();
      return;
    }
    this.clearReadyTimer();
    this.killProcess("SIGKILL");
    this.process = null;
    this.cleanupTempDir();
  }

  private killProcess(signal: NodeJS.Signals): void {
    if (!this.process) return;
    try {
      process.kill(-this.process.pid!, signal);
    } catch {
      // The shell may not own a process group anymore.
      try {
        this.process.kill(signal);
      } catch {
        // The process may have already exited.
      }
    }
  }

  private clearReadyTimer(): void {
    if (!this.readyTimer) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private cleanupTempDir(): void {
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // Temp scripts are best-effort cleanup; command execution should not throw here.
    }
  }

  private cleanupCommandFile(): void {
    const filePaths = [this.currentCommandFilePath, this.currentCommandDoneFilePath];
    this.currentCommandFilePath = null;
    this.currentCommandDoneFilePath = null;
    this.commandDoneFileReadyAt = null;
    for (const filePath of filePaths) {
      if (!filePath) continue;
      try {
        rmSync(filePath, { force: true });
      } catch {
        // Command artifacts are best-effort cleanup; temp dir cleanup is the fallback.
      }
    }
  }

  private clearCommandDoneFileWatcher(): void {
    if (!this.commandDoneFileTimer) return;
    clearInterval(this.commandDoneFileTimer);
    this.commandDoneFileTimer = null;
    this.commandDoneFileReadyAt = null;
  }

  private startCommandDoneFileWatcher(): void {
    this.clearCommandDoneFileWatcher();
    if (!this.currentCommandDoneFilePath) return;
    this.commandDoneFileTimer = setInterval(() => this.checkCommandDoneFile(), COMMAND_DONE_FILE_POLL_INTERVAL_MS);
    if (typeof this.commandDoneFileTimer === "object" && "unref" in this.commandDoneFileTimer) {
      this.commandDoneFileTimer.unref();
    }
  }

  private checkCommandDoneFile(): void {
    const id = this.currentCommandId;
    const nonce = this.currentCommandNonce;
    const filePath = this.currentCommandDoneFilePath;
    if (!id || !nonce || !filePath) return;

    let contents: string;
    try {
      contents = readFileSync(filePath, "utf8");
    } catch {
      return;
    }

    const line = contents.split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
    const parsed = parseCommandDoneSentinel(line, nonce);
    if (!parsed || parsed.id !== id) return;

    const now = Date.now();
    if (this.commandDoneFileReadyAt === null) {
      this.commandDoneFileReadyAt = now;
      return;
    }
    if (now - this.commandDoneFileReadyAt < COMMAND_DONE_FILE_SETTLE_MS) return;

    const exitCode = Number.parseInt(parsed.exitCodeText, 10);
    this.completeCurrentCommand(parsed.id, Number.isFinite(exitCode) ? exitCode : 1, parsed.cwd, true);
  }

  private flushStdoutBuffer(): void {
    if (!this.currentCommandId || !this.stdoutBuffer) return;
    this.transcript.appendOutput(this.currentCommandId, this.stdoutBuffer.trimEnd());
    this.stdoutBuffer = "";
    this.stdoutBufferTruncated = false;
  }

  private flushStderrBuffer(): void {
    if (!this.currentCommandId || !this.stderrBuffer) return;
    this.transcript.appendOutput(this.currentCommandId, this.stderrBuffer.trimEnd());
    this.stderrBuffer = "";
    this.stderrBufferTruncated = false;
  }

  private completeCurrentCommand(id: string, exitCode: number, cwd: string | null, recordSuccess: boolean): boolean {
    if (!this.currentCommandId || id !== this.currentCommandId) return false;

    this.clearCommandDoneFileWatcher();
    this.state.running = false;
    this.state.lastExitCode = exitCode;
    if (cwd) this.state.cwd = cwd;
    this.flushStdoutBuffer();
    this.flushStderrBuffer();
    this.transcript.finishCommand(id, exitCode);
    const command = this.transcript.getSnapshot().commands.find((entry) => entry.id === id);
    if (command) {
      this.onCommandComplete(command.command, this.state.cwd, exitCode);
      if (recordSuccess && exitCode === 0) {
        this.onCommandSuccess(command.command, this.state.cwd);
      }
    }
    this.currentCommandId = null;
    this.currentCommandNonce = null;
    this.stdoutControlState = "normal";
    this.stderrControlState = "normal";
    this.stdoutBufferTruncated = false;
    this.stderrBufferTruncated = false;
    this.cleanupCommandFile();
    this.onStateChange();
    return true;
  }

  private capPartialOutputBuffer(kind: "stdout" | "stderr"): void {
    const value = kind === "stdout" ? this.stdoutBuffer : this.stderrBuffer;
    if (byteLength(value) <= MAX_PARTIAL_OUTPUT_BUFFER_BYTES) return;

    if (this.currentCommandId) {
      const alreadyTruncated = kind === "stdout" ? this.stdoutBufferTruncated : this.stderrBufferTruncated;
      if (!alreadyTruncated) {
        this.transcript.appendOutput(this.currentCommandId, PARTIAL_OUTPUT_TRUNCATION_MARKER);
      }
    }

    const trimmed = trimStartToMaxBytes(value, MAX_PARTIAL_OUTPUT_BUFFER_BYTES);
    if (kind === "stdout") {
      this.stdoutBuffer = trimmed;
      this.stdoutBufferTruncated = true;
    } else {
      this.stderrBuffer = trimmed;
      this.stderrBufferTruncated = true;
    }
    this.onStateChange();
  }

  private sendRaw(text: string): void {
    if (!this.process) return;
    this.process.stdin.write(text);
  }

  private handleStderrChunk(chunk: string): void {
    const stripped = stripStreamingTerminalControlSequences(chunk.replace(/\r/g, ""), this.stderrControlState);
    this.stderrControlState = stripped.state;
    const sanitized = stripped.text;
    if (!sanitized || !this.currentCommandId) return;

    this.stderrBuffer += sanitized;
    const parts = this.stderrBuffer.split("\n");
    this.stderrBuffer = parts.pop() ?? "";

    for (const rawLine of parts) {
      const line = rawLine.trimEnd();
      if (!this.currentCommandId) continue;
      this.transcript.appendOutput(this.currentCommandId, line);
      this.onStateChange();
    }
    this.capPartialOutputBuffer("stderr");
  }

  private handleStdoutChunk(chunk: string): void {
    const stripped = stripStreamingTerminalControlSequences(chunk.replace(/\r/g, ""), this.stdoutControlState);
    this.stdoutControlState = stripped.state;
    const sanitized = stripped.text;
    if (!sanitized) return;

    this.stdoutBuffer += sanitized;
    const parts = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = parts.pop() ?? "";

    for (const rawLine of parts) {
      const line = rawLine.trimEnd();
      if (!this.state.ready) {
        const ready = parseReadySentinel(line, this.sentinelNonce);
        if (ready) {
          this.state.ready = true;
          this.state.cwd = ready.cwd || this.state.cwd;
          this.clearReadyTimer();
          this.readyResolve?.();
          this.readyResolve = null;
          this.readyReject = null;
          this.onStateChange();
        }
        continue;
      }

      if (line.startsWith(`${COMMAND_START_SENTINEL}:`) && this.currentCommandNonce) {
        const parsed = parseCommandStartSentinel(line, this.currentCommandNonce);
        if (parsed && parsed.id === this.currentCommandId) {
          if (parsed.cwd) this.state.cwd = parsed.cwd;
          this.onStateChange();
          continue;
        }
      }

      if (line.startsWith(`${COMMAND_DONE_SENTINEL}:`) && this.currentCommandNonce) {
        const parsed = parseCommandDoneSentinel(line, this.currentCommandNonce);
        if (parsed) {
          const exitCode = Number.parseInt(parsed.exitCodeText, 10);
          if (this.completeCurrentCommand(parsed.id, Number.isFinite(exitCode) ? exitCode : 1, parsed.cwd, true)) {
            continue;
          }
        }
      }

      if (!this.currentCommandId) continue;
      this.transcript.appendOutput(this.currentCommandId, line);
      this.onStateChange();
    }
    this.capPartialOutputBuffer("stdout");
  }
}
