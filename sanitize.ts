/**
 * Shared text sanitization helpers.
 *
 * Kept dependency-free so any module (including ones in the
 * icons <-> theme <-> separators <-> powerline-config import cycle) can use it
 * without creating a circular import.
 */

/**
 * Strip terminal control sequences (OSC/DCS/CSI/etc.) and C0/C1 control
 * characters from a string so untrusted text cannot inject escape codes into the
 * rendered status bar. Tab, newline, and carriage return are preserved; callers
 * that need single-line output should collapse those separately.
 */
function stripTerminalStringControls(value: string): string {
  return value
    // OSC strings may be terminated by BEL or ST; if unterminated, drop the
    // payload through EOF instead of exposing hidden control content as text.
    .replace(/(?:\x1B\]|\u009d)[\s\S]*?(?:\u0007|\x1B\\|\u009c|$)/g, "")
    // DCS/SOS/PM/APC strings are ST-terminated. Also consume to EOF when a
    // malformed input omits ST.
    .replace(/(?:\x1B[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1B\\|\u009c|$)/g, "");
}

export function stripTerminalControlSequences(value: string): string {
  return stripTerminalStringControls(value)
    .replace(/(?:\x1B\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

/**
 * Strip terminal controls that can move the cursor, set OSC state, or otherwise
 * affect the terminal while preserving ordinary SGR color/style sequences.
 * Useful for final terminal paint paths that still need trusted ANSI styling.
 */
export function stripUnsafeTerminalControlSequences(value: string): string {
  const sgrSequences: string[] = [];
  const sgrPlaceholder = "\uE000SGR";

  return stripTerminalStringControls(value)
    .replace(/\x1B\[[0-?]*[ -/]*m/g, (sequence) => {
      const index = sgrSequences.push(sequence) - 1;
      return `${sgrPlaceholder}${index}\uE000`;
    })
    .replace(/(?:\x1B\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\uE000SGR(\d+)\uE000/g, (_match, index: string) => sgrSequences[Number(index)] ?? "");
}
