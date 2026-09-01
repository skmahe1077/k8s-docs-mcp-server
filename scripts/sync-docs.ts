import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const K8S_DOCS_REF = "release-1.35";
const REPO_URL = "https://github.com/kubernetes/website.git";
const CACHE_DIR = path.resolve(import.meta.dirname, "..", ".cache", "website");

function run(cmd: string, args: string[], cwd?: string) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function main() {
  if (existsSync(path.join(CACHE_DIR, ".git"))) {
    console.log(`Existing checkout found at ${CACHE_DIR}, updating...`);
    run("git", ["fetch", "--depth", "1", "origin", K8S_DOCS_REF], CACHE_DIR);
    run("git", ["reset", "--hard", "origin/" + K8S_DOCS_REF], CACHE_DIR);
  } else {
    console.log(`Cloning ${REPO_URL} (${K8S_DOCS_REF}) into ${CACHE_DIR}...`);
    run("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      K8S_DOCS_REF,
      "--filter=blob:none",
      "--sparse",
      REPO_URL,
      CACHE_DIR,
    ]);
    run(
      "git",
      ["sparse-checkout", "set", "content/en/docs", "content/en/examples"],
      CACHE_DIR,
    );
  }

  const docsDir = path.join(CACHE_DIR, "content", "en", "docs");
  const examplesDir = path.join(CACHE_DIR, "content", "en", "examples");
  if (!existsSync(docsDir)) {
    throw new Error(`Expected docs directory not found: ${docsDir}`);
  }
  if (!existsSync(examplesDir)) {
    throw new Error(`Expected examples directory not found: ${examplesDir}`);
  }
  console.log("Sync complete.");
  console.log(`  docs:     ${docsDir}`);
  console.log(`  examples: ${examplesDir}`);
}

main();
