import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  IndexNotBuiltError,
  findPage,
  getDomainPages,
  listCertNames,
  listPagesInSection,
  listTopLevelSections,
  loadCurriculum,
  renderPage,
  searchDocs,
  searchExamScoped,
  type SearchResult,
} from "./db.js";

const server = new McpServer({
  name: "k8s-docs-mcp-server",
  version: "0.1.0",
});

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No matching documentation pages found.";
  return results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title}** — ${r.headingPath}\n   ${r.url}\n   ${r.snippet.replace(/\n+/g, " ")}`,
    )
    .join("\n\n");
}

server.registerTool(
  "search_docs",
  {
    title: "Search Kubernetes documentation",
    description:
      "Full-text search over the official Kubernetes documentation (pinned to a fixed release). " +
      "Returns ranked pages with a matching snippet and the canonical kubernetes.io URL. " +
      "Use this for general lookups; use search_exam_scoped when studying for a specific certification.",
    inputSchema: {
      query: z.string().min(1).describe("Search terms, e.g. \"PodDisruptionBudget\" or \"kubectl taint\""),
      limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
      section: z
        .enum(["concepts", "tasks", "tutorials", "reference", "setup", "home"])
        .optional()
        .describe("Restrict results to one top-level docs section"),
    },
  },
  async ({ query, limit, section }) => {
    try {
      return text(formatResults(searchDocs(query, limit, section)));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "get_doc",
  {
    title: "Fetch a Kubernetes documentation page",
    description:
      "Fetch the full normalized text of one documentation page, with any embedded example " +
      "manifests inlined as YAML. Accepts either a kubernetes.io URL or the bare doc path " +
      "(e.g. \"concepts/workloads/controllers/deployment\") returned by search_docs.",
    inputSchema: {
      path: z.string().min(1).describe("A kubernetes.io/docs/... URL or bare doc key"),
    },
  },
  async ({ path: pathOrUrl }) => {
    try {
      const page = findPage(pathOrUrl);
      if (!page) return text(`No page found matching "${pathOrUrl}".`);
      return text(renderPage(page));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "list_sections",
  {
    title: "Browse Kubernetes documentation sections",
    description:
      "List the top-level documentation sections (concepts, tasks, tutorials, reference, setup, " +
      "home) with page counts, or, given a section, list the pages within it.",
    inputSchema: {
      section: z
        .enum(["concepts", "tasks", "tutorials", "reference", "setup", "home"])
        .optional()
        .describe("Section to list pages for; omit to list all sections"),
    },
  },
  async ({ section }) => {
    try {
      if (!section) {
        const sections = listTopLevelSections();
        return text(sections.map((s) => `- ${s.section} (${s.pageCount} pages)`).join("\n"));
      }
      const pages = listPagesInSection(section);
      return text(pages.map((p) => `- **${p.title}** — ${p.url}`).join("\n"));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "list_exam_topics",
  {
    title: "List certification exam domains",
    description:
      "List the official CNCF curriculum domains and exam weights for a Kubernetes certification " +
      "(CKA, CKAD, or CKS), with the competencies covered under each domain.",
    inputSchema: {
      cert: z.enum(["CKA", "CKAD", "CKS"]).describe("Which certification"),
    },
  },
  async ({ cert }) => {
    try {
      const curriculum = loadCurriculum();
      const spec = curriculum[cert];
      if (!spec) return text(`Unknown certification "${cert}". Known: ${listCertNames().join(", ")}`);
      const lines = [
        `${spec.fullName} (${cert}) — curriculum v${spec.curriculumVersion}` +
          (spec.requiresCert ? ` — requires ${spec.requiresCert}` : ""),
        "",
        ...spec.domains.map(
          (d) =>
            `## ${d.name} — ${d.weight}%\n` + d.competencies.map((c) => `- ${c}`).join("\n"),
        ),
      ];
      return text(lines.join("\n"));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "get_topic_docs",
  {
    title: "Get docs for one exam domain",
    description:
      "List the documentation pages curated for a specific certification exam domain, e.g. " +
      "CKA's \"Troubleshooting\" or CKS's \"Supply Chain Security\". Use list_exam_topics first " +
      "to see valid domain names for a cert.",
    inputSchema: {
      cert: z.enum(["CKA", "CKAD", "CKS"]).describe("Which certification"),
      domain: z.string().min(1).describe("Exact domain name as returned by list_exam_topics"),
    },
  },
  async ({ cert, domain }) => {
    try {
      const curriculum = loadCurriculum();
      const spec = curriculum[cert];
      if (!spec) return text(`Unknown certification "${cert}".`);
      const validDomain = spec.domains.some((d) => d.name === domain);
      if (!validDomain) {
        return text(
          `Unknown domain "${domain}" for ${cert}. Valid domains: ${spec.domains.map((d) => d.name).join(", ")}`,
        );
      }
      const pages = getDomainPages(cert, domain);
      return text(pages.map((p) => `- **${p.title}** — ${p.url}`).join("\n"));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "search_exam_scoped",
  {
    title: "Search docs scoped to a certification",
    description:
      "Search the documentation, restricted to pages curated for a given certification (CKA, " +
      "CKAD, or CKS). This is the recommended way to study: it excludes docs pages that aren't " +
      "relevant to that exam's curriculum.",
    inputSchema: {
      cert: z.enum(["CKA", "CKAD", "CKS"]).describe("Which certification to scope to"),
      query: z.string().min(1).describe("Search terms"),
      limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
    },
  },
  async ({ cert, query, limit }) => {
    try {
      return text(formatResults(searchExamScoped(cert, query, limit)));
    } catch (err) {
      return errorText(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  if (err instanceof IndexNotBuiltError) {
    console.error(err.message);
  } else {
    console.error("Fatal error starting k8s-docs-mcp-server:", err);
  }
  process.exit(1);
});
