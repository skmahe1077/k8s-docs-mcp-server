# k8s-docs-mcp-server

An MCP server exposing the official Kubernetes documentation for full-text search and
CKA/CKAD/CKS certification study, grounded in the exact docs version the current exams target.

It works in two phases: an offline indexer that pulls the Kubernetes docs source and builds a
local SQLite full-text index, and a thin MCP server that only reads that index (no network calls
at query time).

## Setup

```bash
npm install
npm run sync    # sparse-clones kubernetes/website (release-1.35) into .cache/website
npm run index   # builds data/k8s-docs.db from the synced docs (~1 minute)
npm run build   # compiles TypeScript to dist/
```

`npm run sync` and `npm run index` need to be re-run whenever you want to refresh the docs (e.g.
to track a new Kubernetes release). To pin a different release, edit `K8S_DOCS_REF` in
`scripts/sync-docs.ts`.

## Registering with an MCP client

Add to your project's `.mcp.json` (or the equivalent in your client):

```json
{
  "mcpServers": {
    "k8s-docs": {
      "command": "node",
      "args": ["/absolute/path/to/k8s-docs-mcp-server/dist/index.js"]
    }
  }
}
```

Or with the Claude Code CLI:

```bash
claude mcp add k8s-docs -- node /absolute/path/to/k8s-docs-mcp-server/dist/index.js
```

During development you can run `npm run dev` (via `tsx`, no build step needed) and point your
client at that command instead.

## Tools

| Tool | Purpose |
|---|---|
| `search_docs(query, limit?, section?)` | Full-text search (BM25) over all docs. Returns ranked pages with a snippet and canonical URL. |
| `get_doc(path)` | Full text of one page, given a bare doc key or a `kubernetes.io/docs/...` URL. Embedded example manifests are inlined as YAML. |
| `list_sections(section?)` | List top-level doc sections with page counts, or the pages within one section. |
| `list_exam_topics(cert)` | Official CNCF curriculum domains, weights, and competencies for `CKA`, `CKAD`, or `CKS`. |
| `get_topic_docs(cert, domain)` | Doc pages curated for one exam domain (e.g. CKA's "Troubleshooting"). |
| `search_exam_scoped(cert, query, limit?)` | Search restricted to one certification's curated doc set — the main tool for focused exam prep. |

## How it works

- **Source**: raw Markdown from the [`kubernetes/website`](https://github.com/kubernetes/website)
  repo, sparse-cloned at the `release-1.35` branch (matches the CKA/CKAD v1.35 curriculum) — not
  scraped HTML.
- **Normalization** (`scripts/lib/normalize.ts`): Hugo shortcodes (`{{< note >}}`, tabs, glossary
  tooltips, `{{< ref >}}` cross-links, etc.) are resolved or stripped to plain, readable Markdown.
  `{{% code_sample file="..." %}}` references are resolved and the actual example YAML is inlined
  into the page text. A handful of rare, purely data-driven shortcodes (feature-gate tables, the
  CVE feed, the tutorials carousel) can't be recovered as text and are dropped — these affect a
  small number of pages and don't carry prose content.
- **Index** (`scripts/build-index.ts`): each page is chunked by heading into a SQLite FTS5 table
  (`porter` stemmer, BM25 ranking), so search returns a specific section rather than a whole page.
- **Curriculum mapping** (`data/curriculum.json`): the CNCF publishes CKA/CKAD/CKS curricula only
  as PDFs, which aren't reliably machine-parseable, so domain names, weights, and the glob patterns
  mapping each domain to doc pages are **hand-curated**. Weights are verified against the published
  CNCF percentages; the doc-page mappings are a best-effort study aid, not an official CNCF
  artifact — treat `search_exam_scoped` as a way to narrow your reading, not a guarantee of exact
  exam coverage.

## Limitations

- English docs only, no live scraping, no semantic/vector search.
- No auto-refresh — re-run `npm run sync && npm run index` to update.
- Curriculum domain-to-page mapping is approximate (see above).
