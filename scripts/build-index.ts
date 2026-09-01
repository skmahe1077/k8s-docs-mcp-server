import Database from "better-sqlite3";
import { readFileSync, mkdirSync, renameSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { buildPathIndex, keyToUrl, walkMarkdownFiles } from "./lib/paths.js";
import { normalizeBody, type NormalizeContext } from "./lib/normalize.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS_ROOT = path.join(ROOT, ".cache", "website", "content", "en", "docs");
const EXAMPLES_ROOT = path.join(ROOT, ".cache", "website", "content", "en", "examples");
const DB_PATH = path.join(ROOT, "data", "k8s-docs.db");
const TMP_DB_PATH = DB_PATH + ".building";
const CURRICULUM_PATH = path.join(ROOT, "data", "curriculum.json");

interface Chunk {
  heading: string;
  headingPath: string;
  body: string;
  ord: number;
}

function chunkByHeading(text: string, pageTitle: string): Chunk[] {
  const lines = text.split("\n");
  const chunks: Chunk[] = [];
  let currentHeading = pageTitle;
  let currentPath = pageTitle;
  let buf: string[] = [];
  let ord = 0;
  const headingStack: { level: number; title: string }[] = [];

  function flush() {
    const body = buf.join("\n").trim();
    if (body) {
      chunks.push({ heading: currentHeading, headingPath: currentPath, body, ord: ord++ });
    }
    buf = [];
  }

  for (const line of lines) {
    const m = /^(#{2,4})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      const title = m[2].trim();
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, title });
      currentHeading = title;
      currentPath = [pageTitle, ...headingStack.map((h) => h.title)].join(" > ");
      continue;
    }
    buf.push(line);
  }
  flush();
  return chunks;
}

function setupSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      content_type TEXT,
      section TEXT NOT NULL
    );

    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      page_id INTEGER NOT NULL REFERENCES pages(id),
      heading TEXT NOT NULL,
      heading_path TEXT NOT NULL,
      body TEXT NOT NULL,
      ord INTEGER NOT NULL
    );

    -- Deliberately NOT an external-content table (no content=/content_rowid=):
    -- FTS5 maps external content by *column position*, and chunks' column
    -- order (id, page_id, heading, heading_path, body, ord) doesn't line up
    -- with these three columns — that mismatch breaks snippet()/highlight().
    -- Standalone mode stores its own copy of the text, which snippet() needs
    -- direct access to anyway.
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      title, heading_path, body,
      tokenize='porter unicode61'
    );

    CREATE INDEX idx_chunks_page_id ON chunks(page_id);

    CREATE TABLE curriculum_pages (
      cert TEXT NOT NULL,
      domain TEXT NOT NULL,
      page_key TEXT NOT NULL,
      FOREIGN KEY (page_key) REFERENCES pages(key)
    );
    CREATE INDEX idx_curriculum_cert_domain ON curriculum_pages(cert, domain);
  `);
}

function sectionOf(key: string): string {
  return key.split("/")[0] || "home";
}

function main() {
  if (!existsSync(DOCS_ROOT)) {
    throw new Error(`Docs not found at ${DOCS_ROOT}. Run "npm run sync" first.`);
  }

  console.log("Walking markdown files...");
  const files = walkMarkdownFiles(DOCS_ROOT);
  console.log(`Found ${files.length} pages.`);
  const pathIndex = buildPathIndex(files);

  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (existsSync(TMP_DB_PATH)) unlinkSync(TMP_DB_PATH);

  const db = new Database(TMP_DB_PATH);
  setupSchema(db);

  const insertPage = db.prepare(
    `INSERT INTO pages (key, url, title, description, content_type, section)
     VALUES (@key, @url, @title, @description, @content_type, @section)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, page_id, heading, heading_path, body, ord)
     VALUES (@id, @pageId, @heading, @headingPath, @body, @ord)`,
  );
  const insertChunkFts = db.prepare(
    `INSERT INTO chunks_fts (rowid, title, heading_path, body)
     VALUES (@id, @title, @headingPath, @body)`,
  );

  const unmatchedTags = new Set<string>();
  const missingIncludes = new Set<string>();
  const missingExamples = new Set<string>();
  let chunkId = 0;
  let pageCount = 0;
  let chunkCount = 0;

  const tx = db.transaction(() => {
    for (const file of files) {
      const raw = readFileSync(file.absPath, "utf8");
      const { data: frontMatter, content } = matter(raw);
      const title: string = frontMatter.title || file.key || "Kubernetes Documentation";

      // Skip pure redirect/alias stubs with no real body.
      if (!content.trim() && !frontMatter.title) continue;

      const ctx: NormalizeContext = {
        currentDir: file.dir,
        docsRoot: DOCS_ROOT,
        examplesRoot: EXAMPLES_ROOT,
        pathIndex,
        unmatchedTags,
        missingIncludes,
        missingExamples,
      };
      const normalized = normalizeBody(content, ctx);
      if (!normalized) continue;

      const url = keyToUrl(file.key);
      const info = insertPage.run({
        key: file.key,
        url,
        title,
        description: frontMatter.description ?? null,
        content_type: frontMatter.content_type ?? null,
        section: sectionOf(file.key),
      });
      pageCount++;

      const chunks = chunkByHeading(normalized, title);
      for (const chunk of chunks) {
        chunkId++;
        insertChunk.run({
          id: chunkId,
          pageId: info.lastInsertRowid,
          heading: chunk.heading,
          headingPath: chunk.headingPath,
          body: chunk.body,
          ord: chunk.ord,
        });
        insertChunkFts.run({
          id: chunkId,
          title,
          headingPath: chunk.headingPath,
          body: chunk.body,
        });
        chunkCount++;
      }
    }
  });
  tx();

  console.log(`Indexed ${pageCount} pages, ${chunkCount} chunks.`);
  if (unmatchedTags.size) {
    console.warn(`Unmatched shortcode tags (stripped): ${[...unmatchedTags].join(", ")}`);
  }
  if (missingIncludes.size) {
    console.warn(`Missing include targets (dropped): ${[...missingIncludes].join(", ")}`);
  }
  if (missingExamples.size) {
    console.warn(`Missing example files (dropped): ${[...missingExamples].join(", ")}`);
  }

  console.log("Resolving curriculum.json doc patterns...");
  loadCurriculum(db);

  db.close();
  renameSync(TMP_DB_PATH, DB_PATH);
  console.log(`Wrote ${DB_PATH}`);
}

function globToRegExp(glob: string): RegExp {
  // Supports `**` (any depth) and `*` (single segment) against page keys.
  const escaped = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

function loadCurriculum(db: Database.Database) {
  const curriculum = JSON.parse(readFileSync(CURRICULUM_PATH, "utf8"));
  const allKeys: string[] = db.prepare("SELECT key FROM pages").all().map((r: any) => r.key);
  const insert = db.prepare(
    "INSERT INTO curriculum_pages (cert, domain, page_key) VALUES (?, ?, ?)",
  );

  for (const [cert, spec] of Object.entries<any>(curriculum)) {
    const totalWeight = spec.domains.reduce((s: number, d: any) => s + d.weight, 0);
    if (Math.abs(totalWeight - 100) > 0.01) {
      throw new Error(`${cert} domain weights sum to ${totalWeight}, expected 100`);
    }
    for (const domain of spec.domains) {
      let matched = 0;
      for (const pattern of domain.docPatterns) {
        const re = globToRegExp(pattern);
        for (const key of allKeys) {
          if (re.test(key)) {
            insert.run(cert, domain.name, key);
            matched++;
          }
        }
      }
      if (matched === 0) {
        throw new Error(
          `${cert} domain "${domain.name}" matched zero pages — check its docPatterns`,
        );
      }
      console.log(`  ${cert} / ${domain.name}: ${matched} pages`);
    }
  }
}

main();
