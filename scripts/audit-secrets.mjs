import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const IGNORED_ENTRY_NAMES = new Set([
  ".git",
  ".agents",
  ".codex",
  ".planning",
  "graphify-out",
  "node_modules",
  "out",
  "dist",
  "release",
  "artifacts"
]);
// Generated native build output, gitignored exactly like out/ and dist/. node-gyp
// writes the builder's absolute home path into the generated project files and
// objects, which is build-environment noise rather than publishable content.
// `build/` itself is not ignored: it also holds tracked icons and resources.
const IGNORED_RELATIVE_PATHS = new Set([
  "build/windows-agent-pipe-host",
  "native/windows-agent-pipe-host/build"
]);
const BUILD_OUTPUT_DIRECTORY = "out";
const BINARY_EXTENSIONS = new Set([
  ".gif", ".icns", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".webp", ".zip"
]);
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export const SECRET_PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  // The negative lookbehind keeps identifier-like text that merely contains a
  // key prefix (`disk-…`, `task-…`) out of the report; a real key never follows
  // an alphanumeric character.
  ["Anthropic token", /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/g],
  ["OpenAI-style token", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}/g],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{16,}/g],
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  [
    "hard-coded secret assignment",
    /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'`][^"'`\r\n]{12,}["'`]/gi
  ],
  // Personal home directories: a `home` or `Users` path segment on Linux and
  // macOS, or a drive-rooted `Users` directory on Windows. Both branches require
  // a name segment after the user directory and a separator after that name, so
  // generic environment content such as a bare `%USERPROFILE%` cannot match, and
  // the Windows branch requires the drive prefix so system directories such as
  // `C:\Windows` or `C:\Program Files` cannot match. CI runner homes are exempt
  // in both branches.
  [
    "personal home path",
    /(?:\/(?:home|Users)\/(?!runner(?:\/|$))[^/\s"'`]+\/|[A-Za-z]:\\[Uu]sers\\(?!runner(?:\\|$))[^\\\s"'`]+\\)/g
  ]
];

const SENSITIVE_FILE_NAMES = [
  /^\.env(?:\.|$)/i,
  /^(?:credentials?|auth|secrets?)(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx)$/i
];

export async function collectRepositoryIssues(root = PROJECT_ROOT) {
  return scanFiles(await walk(root, root), root);
}

/**
 * Scans the built application bundle, which is what electron-builder packages and
 * what a build-time-injected value ends up inside. Returns `null` when no build
 * exists, so a caller can tell "nothing was scanned" from "scanned and clean"
 * instead of reporting coverage it does not have.
 */
export async function collectArtifactIssues(root = PROJECT_ROOT) {
  const artifactRoot = resolve(root, BUILD_OUTPUT_DIRECTORY);
  if (!await isDirectory(artifactRoot)) return null;
  return scanFiles(await walk(artifactRoot, root), root);
}

async function scanFiles(files, root) {
  const issues = [];

  for (const file of files) {
    const projectPath = relative(root, file).replaceAll("\\", "/");
    const baseName = projectPath.split("/").at(-1) ?? projectPath;

    for (const rule of SENSITIVE_FILE_NAMES) {
      if (rule.test(baseName) && baseName !== ".env.example") {
        issues.push({ path: projectPath, rule: "sensitive filename" });
      }
      rule.lastIndex = 0;
    }

    if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > MAX_TEXT_FILE_BYTES) continue;

    const content = await readFile(file, "utf8");
    for (const [name, pattern] of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) issues.push({ path: projectPath, rule: name });
    }
  }

  return issues;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function walk(directory, root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    // In a normal clone .git is a directory; in a Git worktree it is a file
    // containing an absolute gitdir path. Both forms are repository metadata,
    // not publishable project content, so skip the entry before inspecting type.
    if (IGNORED_ENTRY_NAMES.has(entry.name)) continue;

    const path = resolve(directory, entry.name);
    if (IGNORED_RELATIVE_PATHS.has(relative(root, path).replaceAll("\\", "/"))) continue;
    if (entry.isDirectory()) files.push(...await walk(path, root));
    else if (entry.isFile()) files.push(path);
  }

  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifactIssues = await collectArtifactIssues();
  const issues = [...await collectRepositoryIssues(), ...(artifactIssues ?? [])];

  if (issues.length > 0) {
    console.error("Secret audit failed:");
    for (const issue of issues) console.error(`- ${issue.path}: ${issue.rule}`);
    process.exitCode = 1;
  } else if (artifactIssues === null) {
    console.log(
      `Repository secret audit passed: no high-confidence secrets or private paths found in the repository source tree. `
      + `No built application bundle exists (${BUILD_OUTPUT_DIRECTORY}/), so the packaged output was not scanned; `
      + "run the audit after `npm run build` to gate the artifact too."
    );
  } else {
    console.log(
      "Secret audit passed: no high-confidence secrets or private paths found in the repository source tree "
      + `or the built ${BUILD_OUTPUT_DIRECTORY}/ application bundle.`
    );
  }
}
