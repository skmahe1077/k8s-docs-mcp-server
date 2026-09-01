import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(ROOT, "data", "k8s-docs.db");
const CURRICULUM_PATH = path.join(ROOT, "data", "curriculum.json");

export class IndexNotBuiltError extends Error {
  constructor() {
    super(
      `Documentation index not found at ${DB_PATH}. Run "npm run sync && npm run index" in the server directory first.`,
    );
    this.name = "IndexNotBuiltError";
  }
}

function openDb(): Database.Database {
  if (!existsSync(DB_PATH)) throw new IndexNotBuiltError();
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

let db: Database.Database | undefined;
function getDb(): Database.Database {
  if (!db) db = openDb();
  return db;
}

export interface CurriculumDomain {
  name: string;
  weight: number;
  competencies: string[];
}
export interface CurriculumCert {
  curriculumVersion: string;
  fullName: string;
  requiresCert?: string;
  domains: CurriculumDomain[];
}
export type Curriculum = Record<string, CurriculumCert>;

let curriculumCache: Curriculum | undefined;
export function loadCurriculum(): Curriculum {
  if (!curriculumCache) {
    if (!existsSync(CURRICULUM_PATH)) {
      throw new Error(`Curriculum data not found at ${CURRICULUM_PATH}`);
    }
    curriculumCache = JSON.parse(readFileSync(CURRICULUM_PATH, "utf8"));
  }
  return curriculumCache!;
}

const MAX_QUERY_TOKENS = 12;

/** Turn free-text user input into a safe FTS5 MATCH expression (bound as a
 * parameter, but FTS5's own query syntax can still throw on raw special
 * characters like leading `-` or unbalanced quotes — quoting every token as a
 * literal phrase sidesteps that while keeping porter stemming intact). */
function toFtsQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_QUERY_TOKENS);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export interface SearchResult {
  title: string;
  url: string;
  key: string;
  section: string;
  heading: string;
  headingPath: string;
  snippet: string;
}

function runSearch(
  query: string,
  limit: number,
  extraWhere: string,
  extraParams: unknown[],
): SearchResult[] {
  const fts = toFtsQuery(query);
  const rows = getDb()
    .prepare(
      `SELECT p.title, p.url, p.key, p.section, c.heading, c.heading_path as headingPath,
              snippet(chunks_fts, 2, '**', '**', '…', 24) as snippet,
              bm25(chunks_fts, 4.0, 2.0, 1.0) as rank
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       JOIN pages p ON p.id = c.page_id
       WHERE chunks_fts MATCH ? ${extraWhere}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(fts, ...extraParams, limit * 4) as (SearchResult & { rank: number })[];

  // Collapse to the single best-ranked chunk per page so a page with many
  // matching sections doesn't crowd out other relevant pages.
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

const MAX_LIMIT = 25;
function clampLimit(limit: number | undefined, fallback: number): number {
  if (!limit || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

export function searchDocs(query: string, limit?: number, section?: string): SearchResult[] {
  const extraWhere = section ? "AND p.section = ?" : "";
  const extraParams = section ? [section] : [];
  return runSearch(query, clampLimit(limit, 10), extraWhere, extraParams);
}

export function searchExamScoped(
  cert: string,
  query: string,
  limit?: number,
): SearchResult[] {
  return runSearch(
    query,
    clampLimit(limit, 10),
    "AND p.key IN (SELECT page_key FROM curriculum_pages WHERE cert = ?)",
    [cert],
  );
}

export interface PageRow {
  key: string;
  url: string;
  title: string;
  description: string | null;
  section: string;
}

export function findPage(pathOrUrl: string): PageRow | undefined {
  let key = pathOrUrl.trim();
  key = key.replace(/^https?:\/\/kubernetes\.io\/docs\//, "");
  key = key.replace(/^\/+|\/+$/g, "");
  return getDb()
    .prepare("SELECT key, url, title, description, section FROM pages WHERE key = ?")
    .get(key) as PageRow | undefined;
}

export function renderPage(page: PageRow): string {
  const chunks = getDb()
    .prepare("SELECT heading, body FROM chunks WHERE page_id = (SELECT id FROM pages WHERE key = ?) ORDER BY ord")
    .all(page.key) as { heading: string; body: string }[];

  const parts = [`# ${page.title}`];
  if (page.description) parts.push(page.description);
  for (const chunk of chunks) {
    if (chunk.heading && chunk.heading !== page.title) {
      parts.push(`## ${chunk.heading}`);
    }
    parts.push(chunk.body);
  }
  return parts.join("\n\n");
}

export interface SectionSummary {
  section: string;
  pageCount: number;
}

export function listTopLevelSections(): SectionSummary[] {
  return getDb()
    .prepare(
      "SELECT section, COUNT(*) as pageCount FROM pages GROUP BY section ORDER BY section",
    )
    .all() as SectionSummary[];
}

export interface PageSummary {
  key: string;
  url: string;
  title: string;
}

export function listPagesInSection(section: string, limit = 200): PageSummary[] {
  return getDb()
    .prepare("SELECT key, url, title FROM pages WHERE section = ? ORDER BY key LIMIT ?")
    .all(section, clampLimit(limit, 200)) as PageSummary[];
}

export function listCertNames(): string[] {
  return Object.keys(loadCurriculum());
}

export function getDomainPages(cert: string, domain: string): PageSummary[] {
  return getDb()
    .prepare(
      `SELECT p.key, p.url, p.title
       FROM curriculum_pages cp
       JOIN pages p ON p.key = cp.page_key
       WHERE cp.cert = ? AND cp.domain = ?
       ORDER BY p.key`,
    )
    .all(cert, domain) as PageSummary[];
}
