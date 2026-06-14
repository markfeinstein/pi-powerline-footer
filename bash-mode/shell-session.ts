import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BashTranscriptStore } from "./transcript.ts";
import type { ShellSessionState } from "./types.ts";

const READY_SENTINEL = "__PI_READY__";
const COMMAND_START_SENTINEL = "__PI_CMD_START__";
const COMMAND_DONE_SENTINEL = "__PI_CMD_DONE__";

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\u0007]*(?:\u0007|\x1b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
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

function parseCommandDoneSentinel(line: string, nonce: string): { id: string; exitCodeText: string; cwd: string } | null {
  const prefix = `${COMMAND_DONE_SENTINEL}:${nonce}:`;
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
function __pi_eval
  set -l __pi_id $argv[1]
  set -l __pi_source_file $argv[2]
  echo "${COMMAND_START_SENTINEL}:${nonce}:$__pi_id:$PWD"
  source $__pi_source_file
  set -l __pi_status $status
  echo ""
  echo "${COMMAND_DONE_SENTINEL}:${nonce}:$__pi_id:$__pi_status:$PWD"
end
echo "${READY_SENTINEL}:${nonce}:$PWD"
`;
  }

  if (shellName.includes("bash")) {
    return `
__pi_eval() {
  local __pi_id="$1"
  local __pi_source_file="$2"
  readonly __pi_source_file
  printf '%s:%s:%s:%s\n' '${COMMAND_START_SENTINEL}' '${nonce}' "$__pi_id" "$PWD"
  source "$__pi_source_file"
  local __pi_status=$?
  printf '\n%s:%s:%s:%s:%s\n' '${COMMAND_DONE_SENTINEL}' '${nonce}' "$__pi_id" "$__pi_status" "$PWD"
}
printf '%s:%s:%s\n' '${READY_SENTINEL}' '${nonce}' "$PWD"
`;
  }

  if (!shellName.includes("zsh")) {
    return `
__pi_eval() {
  __pi_id="$1"
  __pi_source_file="$2"
  readonly __pi_source_file
  printf '%s:%s:%s:%s\n' '${COMMAND_START_SENTINEL}' '${nonce}' "$__pi_id" "$PWD"
  . "$__pi_source_file"
  __pi_status=$?
  printf '\n%s:%s:%s:%s:%s\n' '${COMMAND_DONE_SENTINEL}' '${nonce}' "$__pi_id" "$__pi_status" "$PWD"
}
printf '%s:%s:%s\n' '${READY_SENTINEL}' '${nonce}' "$PWD"
`;
  }

  return `
function __pi_eval() {
  local __pi_id="$1"
  local -r __pi_source_file="$2"
  print -r -- "${COMMAND_START_SENTINEL}:${nonce}:$__pi_id:$PWD"
  builtin source "$__pi_source_file"
  local __pi_status=$?
  print -r -- ""
  print -r -- "${COMMAND_DONE_SENTINEL}:${nonce}:$__pi_id:$__pi_status:$PWD"
}
print -r -- "${READY_SENTINEL}:${nonce}:$PWD"
`;
}

export class ManagedShellSession {
  private readonly shellPath: string;
  private readonly transcript: BashTranscriptStore;
  private readonly onStateChange: () => void;
  private readonly onCommandSuccess: (command: string, cwd: string) => void;
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly tempDir = mkdtempSync(join(tmpdir(), "powerline-bash-mode-"));
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private commandCounter = 0;
  private currentCommandId: string | null = null;
  private currentCommandFilePath: string | null = null;
  private readonly sentinelNonce = randomBytes(16).toString("hex");
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private disposed = false;
  readonly state: ShellSessionState;

  constructor(
    shellPath: string,
    cwd: string,
    transcript: BashTranscriptStore,
    onStateChange: () => void,
    onCommandSuccess: (command: string, cwd: string) => void,
  ) {
    this.shellPath = shellPath;
    this.transcript = transcript;
    this.onStateChange = onStateChange;
    this.onCommandSuccess = onCommandSuccess;
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

    this.process = spawn(this.shellPath, [], {
      cwd: this.state.cwd,
      env: {
        ...process.env,
        DISABLE_AUTO_UPDATE: "true",
        DISABLE_UPDATE_PROMPT: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.handleStdoutChunk(String(chunk)));
    this.process.stderr.on("data", (chunk) => this.handleStderrChunk(String(chunk)));
    this.process.on("error", (error) => {
      if (!this.state.ready) {
        this.readyReject?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.process.on("close", (code, signal) => {
      const exitCode = getCloseExitCode(code, signal);
      if (!this.disposed && !this.state.ready) {
        this.readyReject?.(new Error(`Shell failed to start (exit ${exitCode})`));
      }

      if (this.currentCommandId) {
        this.state.lastExitCode = exitCode;
        this.flushStderrBuffer();
        this.transcript.finishCommand(this.currentCommandId, exitCode);
        this.currentCommandId = null;
        this.cleanupCommandFile();
      }

      this.process = null;
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      this.readyPromise = null;
      this.readyResolve = null;
      this.readyReject = null;
      this.state.ready = false;
      this.state.running = false;
      this.cleanupTempDir();
      this.onStateChange();
    });

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
    mkdirSync(this.tempDir, { recursive: true });
    writeFileSync(filePath, command.endsWith("\n") ? command : `${command}\n`, "utf8");
    chmodSync(filePath, 0o600);

    this.currentCommandId = id;
    this.currentCommandFilePath = filePath;
    this.state.running = true;
    this.transcript.startCommand(id, command, this.state.cwd);
    this.onStateChange();
    this.sendRaw(`__pi_eval ${quoteShellArg(id)} ${quoteShellArg(filePath)}\n`);
  }

  interrupt(): void {
    if (!this.process || !this.state.running) return;
    try {
      process.kill(-this.process.pid!, "SIGINT");
    } catch {
      // The shell may not own a process group anymore.
      this.process.kill("SIGINT");
    }
  }

  dispose(): void {
    this.disposed = true;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    if (!this.process) {
      this.cleanupTempDir();
      return;
    }
    try {
      process.kill(-this.process.pid!, "SIGKILL");
    } catch {
      // The shell may not own a process group anymore.
      this.process.kill("SIGKILL");
    }
    this.process = null;
    this.cleanupTempDir();
  }

  private cleanupTempDir(): void {
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // Temp scripts are best-effort cleanup; command execution should not throw here.
    }
  }

  private cleanupCommandFile(): void {
    const filePath = this.currentCommandFilePath;
    this.currentCommandFilePath = null;
    if (!filePath) return;
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Command scripts are best-effort cleanup; temp dir cleanup is the fallback.
    }
  }

  private flushStderrBuffer(): void {
    if (!this.currentCommandId || !this.stderrBuffer) return;
    this.transcript.appendOutput(this.currentCommandId, this.stderrBuffer.trimEnd());
    this.stderrBuffer = "";
  }

  private sendRaw(text: string): void {
    if (!this.process) return;
    this.process.stdin.write(text);
  }

  private handleStderrChunk(chunk: string): void {
    const sanitized = stripAnsi(chunk).replace(/\r/g, "");
    if (!sanitized || !this.currentCommandId) return;

    this.stderrBuffer += sanitized;
    const parts = this.stderrBuffer.split("\n");
    this.stderrBuffer = parts.pop() ?? "";

    for (const rawLine of parts) {
      const line = rawLine.trimEnd();
      this.transcript.appendOutput(this.currentCommandId, line);
      this.onStateChange();
    }
  }

  private handleStdoutChunk(chunk: string): void {
    const sanitized = stripAnsi(chunk).replace(/\r/g, "");
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
          this.readyResolve?.();
          this.readyResolve = null;
          this.readyReject = null;
          this.onStateChange();
        }
        continue;
      }

      if (line.startsWith(`${COMMAND_START_SENTINEL}:`)) {
        const parsed = parseCommandStartSentinel(line, this.sentinelNonce);
        if (parsed && parsed.id === this.currentCommandId) {
          if (parsed.cwd) this.state.cwd = parsed.cwd;
          this.onStateChange();
          continue;
        }
      }

      if (line.startsWith(`${COMMAND_DONE_SENTINEL}:`)) {
        const parsed = parseCommandDoneSentinel(line, this.sentinelNonce);
        if (parsed && parsed.id === this.currentCommandId) {
          const exitCode = Number.parseInt(parsed.exitCodeText, 10);
          this.state.running = false;
          this.state.lastExitCode = Number.isFinite(exitCode) ? exitCode : 1;
          if (parsed.cwd) this.state.cwd = parsed.cwd;
          this.flushStderrBuffer();
          this.transcript.finishCommand(parsed.id, this.state.lastExitCode);
          const snapshot = this.transcript.getSnapshot();
          const command = snapshot.commands.find((entry) => entry.id === parsed.id);
          if (command && this.state.lastExitCode === 0) {
            this.onCommandSuccess(command.command, this.state.cwd);
          }
          this.currentCommandId = null;
          this.cleanupCommandFile();
          this.onStateChange();
          continue;
        }
      }

      if (!this.currentCommandId) continue;
      this.transcript.appendOutput(this.currentCommandId, line);
      this.onStateChange();
    }
  }
}
