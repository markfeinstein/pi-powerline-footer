const input = await new Promise((resolve, reject) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", reject);
});

const expectedFiles = [
  "CHANGELOG.md",
  "README.md",
  "banner.png",
  "bash-mode/completion.ts",
  "bash-mode/editor.ts",
  "bash-mode/history.ts",
  "bash-mode/shell-session.ts",
  "bash-mode/transcript.ts",
  "bash-mode/types.ts",
  "colors.ts",
  "context-usage.ts",
  "fixed-editor/cluster.ts",
  "fixed-editor/terminal-split.ts",
  "git-status.ts",
  "icons.ts",
  "index.ts",
  "layout.ts",
  "package.json",
  "pills.ts",
  "powerline-config.ts",
  "presets.ts",
  "project-key.ts",
  "render-scheduler.ts",
  "segments.ts",
  "separators.ts",
  "shortcuts.ts",
  "theme.example.json",
  "theme.ts",
  "types.ts",
  "welcome-dismiss.ts",
  "welcome.ts",
  "working-vibes.ts",
].sort();

function fail(message) {
  console.error(`[pack:check] ${message}`);
  process.exitCode = 1;
}

let parsed;
try {
  parsed = JSON.parse(input);
} catch (error) {
  fail(`Failed to parse npm pack JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit();
}

const pack = Array.isArray(parsed) ? parsed[0] : null;
if (!pack || !Array.isArray(pack.files)) {
  fail("Unexpected npm pack JSON shape");
  process.exit();
}

const actualFiles = pack.files.map((file) => file.path).sort();
const expectedSet = new Set(expectedFiles);
const actualSet = new Set(actualFiles);
const missing = expectedFiles.filter((file) => !actualSet.has(file));
const unexpected = actualFiles.filter((file) => !expectedSet.has(file));

if (missing.length > 0) {
  fail(`Missing expected package files: ${missing.join(", ")}`);
}

if (unexpected.length > 0) {
  fail(`Unexpected package files: ${unexpected.join(", ")}`);
}

const forbiddenPrefixes = [".github/", "node_modules/", "scripts/", "tests/"];
const forbiddenNames = new Set(["progress.md"]);
const forbidden = actualFiles.filter((file) => forbiddenNames.has(file) || forbiddenPrefixes.some((prefix) => file.startsWith(prefix)));
if (forbidden.length > 0) {
  fail(`Forbidden files included in package: ${forbidden.join(", ")}`);
}

if (pack.entryCount !== expectedFiles.length) {
  fail(`Expected entryCount ${expectedFiles.length}, got ${pack.entryCount}`);
}

if (process.exitCode) {
  process.exit();
}

console.log(`[pack:check] ${actualFiles.length} expected package files verified`);
