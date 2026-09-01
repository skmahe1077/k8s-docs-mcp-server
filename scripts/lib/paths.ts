import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const EXCLUDED_DIR_NAMES = new Set([
  "contribute",
  "doc-contributor-tools",
  "images",
  "included", // indexed separately when inlined via `include`/`tab include=`
]);
const EXCLUDED_FILE_NAMES = new Set(["test.md", "_index.md.orig"]);

export interface DocFile {
  /** absolute path on disk */
  absPath: string;
  /** posix path relative to the docs root, e.g. "concepts/workloads/pods/_index.md" */
  relPath: string;
  /** posix dir of relPath, e.g. "concepts/workloads/pods" */
  dir: string;
  /** canonical key used for cross-referencing: _index-stripped, extension-stripped */
  key: string;
}

export function walkMarkdownFiles(docsRoot: string): DocFile[] {
  const results: DocFile[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry)) continue;
        walk(abs);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      if (EXCLUDED_FILE_NAMES.has(entry)) continue;

      const relPath = path.relative(docsRoot, abs).split(path.sep).join("/");
      const dirPosix = path.posix.dirname(relPath);
      const withoutExt = relPath.slice(0, -3); // strip ".md"
      const key =
        path.posix.basename(withoutExt) === "_index"
          ? path.posix.dirname(withoutExt) === "."
            ? ""
            : path.posix.dirname(withoutExt)
          : withoutExt;

      results.push({ absPath: abs, relPath, dir: dirPosix === "." ? "" : dirPosix, key });
    }
  }

  walk(docsRoot);
  return results;
}

export function keyToUrl(key: string): string {
  return key === "" ? "https://kubernetes.io/docs/" : `https://kubernetes.io/docs/${key}/`;
}

/** Build a lookup from canonical key -> public URL, for resolving `{{< ref >}}` targets. */
export function buildPathIndex(files: DocFile[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const f of files) {
    index.set(f.key, keyToUrl(f.key));
  }
  return index;
}

/**
 * Resolve a `{{< ref "..." >}}` / `{{< relref "..." >}}` argument (relative to the
 * referencing file's directory, may include a `#anchor`) to a public docs URL.
 * Returns null if the target isn't a page we indexed.
 */
export function resolveRef(
  rawArg: string,
  currentDir: string,
  pathIndex: Map<string, string>,
): string | null {
  const [rawPathPart, anchor] = rawArg.split("#");
  let pathPart = rawPathPart.trim();
  if (pathPart.endsWith(".md")) pathPart = pathPart.slice(0, -3);

  let joined: string;
  if (pathPart.startsWith("/")) {
    // Absolute-style ref, typically "/docs/<key>"
    joined = pathPart.replace(/^\/docs\//, "").replace(/^\//, "");
  } else {
    joined = path.posix.normalize(path.posix.join(currentDir, pathPart));
  }
  joined = joined.replace(/\/$/, "");
  if (joined === ".") joined = "";

  const url = pathIndex.get(joined);
  if (!url) return null;
  return anchor ? `${url}#${anchor}` : url;
}
