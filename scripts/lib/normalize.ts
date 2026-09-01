import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { resolveRef } from "./paths.js";

const K8S_VERSION = "1.35";
const MAX_PASSES = 5;

// Hugo shortcodes in this corpus are written inconsistently with `{{< >}}` and
// `{{% %}}` delimiters for the *same* shortcode name (e.g. both `{{< note >}}`
// and `{{% note %}}` occur). Every pattern below therefore accepts either
// opening/closing delimiter independently rather than requiring them to match.
const OPEN = "\\{\\{[%<]";
const CLOSE = "[%>]\\}\\}";

const HEADING_TITLES: Record<string, string> = {
  cleanup: "Cleaning up",
  envvars: "Environment variables",
  examples: "Examples",
  objectives: "Objectives",
  options: "Options",
  parentoptions: "Options inherited from parent commands",
  prerequisites: "Before you begin",
  seealso: "See also",
  synopsis: "Synopsis",
  whatsnext: "What's next",
};

export interface NormalizeContext {
  currentDir: string; // posix dir of the file being processed, relative to docsRoot
  docsRoot: string; // absolute path to content/en/docs
  examplesRoot: string; // absolute path to content/en/examples
  pathIndex: Map<string, string>;
  unmatchedTags: Set<string>;
  missingIncludes: Set<string>;
  missingExamples: Set<string>;
}

function humanize(id: string): string {
  const words = id.replace(/[-_]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function langFromExt(file: string): string {
  const ext = path.extname(file).slice(1);
  return ext || "yaml";
}

function readExample(file: string, ctx: NormalizeContext): string | null {
  const abs = path.join(ctx.examplesRoot, file);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf8").replace(/\s+$/, "");
}

function readInclude(rawArg: string, ctx: NormalizeContext): string | null {
  const candidates = [
    path.join(ctx.docsRoot, ctx.currentDir, rawArg),
    path.join(ctx.docsRoot, ctx.currentDir, "included", rawArg),
  ];
  for (const abs of candidates) {
    if (existsSync(abs)) {
      const raw = readFileSync(abs, "utf8");
      // Included fragments occasionally carry their own front matter; strip it.
      return matter(raw).content;
    }
  }
  return null;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) attrs[m[1]] = m[2];
  return attrs;
}

function normalizeOnce(text: string, ctx: NormalizeContext): string {
  let out = text;

  // --- code_sample / code (embed example manifests) ---
  out = out.replace(
    new RegExp(`${OPEN}\\s*code(?:_sample)?\\s+([^%<>]*?)\\/?${CLOSE}`, "g"),
    (_m, rawAttrs: string) => {
      const attrs = parseAttrs(rawAttrs);
      if (!attrs.file) return "";
      const content = readExample(attrs.file, ctx);
      if (content === null) {
        ctx.missingExamples.add(attrs.file);
        return "";
      }
      const lang = attrs.language || langFromExt(attrs.file);
      return `\n\`\`\`${lang}\n${content}\n\`\`\`\n`;
    },
  );

  // --- tabs wrapper (plural) ---
  out = out.replace(new RegExp(`${OPEN}\\s*tabs\\b[^%<>]*${CLOSE}`, "g"), "");
  out = out.replace(new RegExp(`${OPEN}\\s*\\/\\s*tabs\\s*${CLOSE}`, "g"), "");

  // --- {{% tab name="X" %}}...{{% /tab %}} (paired, percent) ---
  out = out.replace(
    /\{\{%\s*tab\s+([^%]*?)%\}\}([\s\S]*?)\{\{%\s*\/\s*tab\s*%\}\}/g,
    (_m, rawAttrs: string, inner: string) => {
      const { name } = parseAttrs(rawAttrs);
      return `\n**${name ?? "Tab"}**\n${inner}\n`;
    },
  );

  // --- {{< tab name="X" include="Y" />}} (self-closing; must run before the
  //     paired-tab regex below, since its lazy `[^>]*?` would otherwise treat
  //     this as an opening tag and swallow unrelated content up to the next
  //     `{{< /tab >}}` anywhere later in the file) ---
  out = out.replace(/\{\{<\s*tab\s+([^>]*?)\/>\}\}/g, (_m, rawAttrs: string) => {
    const attrs = parseAttrs(rawAttrs);
    if (!attrs.include) return `\n**${attrs.name ?? "Tab"}**\n`;
    const content = readInclude(attrs.include, ctx);
    if (content === null) {
      ctx.missingIncludes.add(attrs.include);
      return `\n**${attrs.name ?? "Tab"}**\n`;
    }
    return `\n**${attrs.name ?? "Tab"}**\n${content}\n`;
  });

  // --- {{< tab name="X" codelang="Y" >}}...{{< /tab >}} ---
  out = out.replace(
    /\{\{<\s*tab\s+([^>]*?)>\}\}([\s\S]*?)\{\{<\s*\/\s*tab\s*>\}\}/g,
    (_m, rawAttrs: string, inner: string) => {
      const attrs = parseAttrs(rawAttrs);
      const lang = attrs.codelang || "";
      return `\n**${attrs.name ?? "Tab"}**\n\`\`\`${lang}\n${inner.trim()}\n\`\`\`\n`;
    },
  );

  // --- note / caution / warning (paired, either delimiter) ---
  for (const [tag, label] of [
    ["note", "Note"],
    ["caution", "Caution"],
    ["warning", "Warning"],
  ] as const) {
    const re = new RegExp(
      `${OPEN}\\s*${tag}\\s*${CLOSE}([\\s\\S]*?)${OPEN}\\s*\\/\\s*${tag}\\s*${CLOSE}`,
      "gi",
    );
    out = out.replace(re, (_m, inner: string) => `\n**${label}:** ${inner.trim()}\n`);
  }

  // --- alert (paired, either delimiter) ---
  out = out.replace(
    new RegExp(`${OPEN}\\s*alert\\s*([^%<>]*?)${CLOSE}([\\s\\S]*?)${OPEN}\\s*\\/\\s*alert\\s*${CLOSE}`, "g"),
    (_m, rawAttrs: string, inner: string) => {
      const { title } = parseAttrs(rawAttrs);
      return `\n**${title || "Note"}:** ${inner.trim()}\n`;
    },
  );

  // --- mermaid (paired) ---
  out = out.replace(
    /\{\{<\s*mermaid\s*>\}\}([\s\S]*?)\{\{<\s*\/\s*mermaid\s*>\}\}/g,
    (_m, inner: string) => `\n\`\`\`mermaid\n${inner.trim()}\n\`\`\`\n`,
  );

  // --- highlight (paired) ---
  out = out.replace(
    /\{\{<\s*highlight\s+(\w+)[^>]*>\}\}([\s\S]*?)\{\{<\s*\/\s*highlight\s*>\}\}/g,
    (_m, lang: string, inner: string) => `\n\`\`\`${lang}\n${inner.trim()}\n\`\`\`\n`,
  );

  // --- comment (paired) — drop entirely ---
  out = out.replace(/\{\{<\s*comment\s*>\}\}([\s\S]*?)\{\{<\s*\/\s*comment\s*>\}\}/g, "");

  // --- pageinfo (paired) ---
  out = out.replace(
    new RegExp(`${OPEN}\\s*pageinfo\\s*([^%<>]*?)${CLOSE}([\\s\\S]*?)${OPEN}\\s*\\/\\s*pageinfo\\s*${CLOSE}`, "g"),
    (_m, _rawAttrs: string, inner: string) => `\n${inner.trim()}\n`,
  );

  // --- details / summary (paired) ---
  out = out.replace(
    new RegExp(`${OPEN}\\s*details\\s+([^%<>]*?)${CLOSE}([\\s\\S]*?)${OPEN}\\s*\\/\\s*details\\s*${CLOSE}`, "g"),
    (_m, rawAttrs: string, inner: string) => {
      const { summary } = parseAttrs(rawAttrs);
      return `\n**${summary || "Details"}**\n${inner.trim()}\n`;
    },
  );

  // --- example (paired, inline text label linking to a sample file) ---
  out = out.replace(
    /\{\{<\s*example\s+([^>]*?)>\}\}([\s\S]*?)\{\{<\s*\/\s*example\s*>\}\}/g,
    (_m, _rawAttrs: string, inner: string) => inner,
  );

  // --- link (self-closing inline link) ---
  out = out.replace(/\{\{<\s*link\s+([^>]*?)\/?>\}\}/g, (_m, rawAttrs: string) => {
    const attrs = parseAttrs(rawAttrs);
    if (!attrs.text) return "";
    return attrs.url ? `[${attrs.text}](${attrs.url})` : attrs.text;
  });

  // --- page-api-reference (self-closing) ---
  out = out.replace(
    /\{\{<\s*page-api-reference\s+([^>]*?)\/?>\}\}/g,
    (_m, rawAttrs: string) => {
      const attrs = parseAttrs(rawAttrs);
      return attrs.kind ? `[Kubernetes API reference: ${attrs.kind}]` : "";
    },
  );

  // --- table (paired, optional caption) ---
  out = out.replace(
    /\{\{<\s*table\s*([^>]*?)>\}\}([\s\S]*?)\{\{<\s*\/\s*table\s*>\}\}/g,
    (_m, rawAttrs: string, inner: string) => {
      const { caption } = parseAttrs(rawAttrs);
      return caption ? `\n**Table: ${caption}**\n${inner}\n` : `\n${inner}\n`;
    },
  );

  // --- thirdparty-content (self-closing) ---
  out = out.replace(/\{\{%\s*thirdparty-content\s*[^%]*%\}\}/g, "");

  // --- glossary_definition (self-closing) ---
  out = out.replace(
    /\{\{<\s*glossary_definition\s+([^>]*?)\/?>\}\}/g,
    (_m, rawAttrs: string) => {
      const attrs = parseAttrs(rawAttrs);
      const term = humanize(attrs.term_id || "");
      return attrs.prepend ? `${attrs.prepend}${term.toLowerCase()}.` : `${term}.`;
    },
  );

  // --- glossary_tooltip (self-closing) ---
  out = out.replace(
    /\{\{<\s*glossary_tooltip\s+([^>]*?)\/?>\}\}/g,
    (_m, rawAttrs: string) => {
      const attrs = parseAttrs(rawAttrs);
      return attrs.text || humanize(attrs.term_id || "");
    },
  );

  // --- heading (self-closing) ---
  out = out.replace(/\{\{%\s*heading\s+"([^"]+)"\s*%\}\}/g, (_m, key: string) => {
    const title = HEADING_TITLES[key] ?? humanize(key);
    return `\n### ${title}\n`;
  });

  // --- feature-state (self-closing) ---
  out = out.replace(
    /\{\{<\s*feature-state\s+([^>]*?)\/?>\}\}/g,
    (_m, rawAttrs: string) => {
      const attrs = parseAttrs(rawAttrs);
      const parts: string[] = [];
      if (attrs.state) parts.push(`state: ${attrs.state}`);
      if (attrs.for_k8s_version) parts.push(`since v${attrs.for_k8s_version}`);
      if (attrs.feature_gate_name) parts.push(`feature gate: ${attrs.feature_gate_name}`);
      return parts.length ? `*(${parts.join(", ")})*` : "";
    },
  );

  // --- api-reference (self-closing, arbitrary attr order/extras) ---
  out = out.replace(
    /\{\{<\s*api-reference\s+([^>]*?)\/?>\}\}/g,
    (_m, rawAttrs: string) => {
      const attrs = parseAttrs(rawAttrs);
      const label = attrs.text || `Kubernetes API reference: ${attrs.page ?? ""}`;
      return `[${label}]`;
    },
  );

  // --- figure (self-closing) ---
  out = out.replace(/\{\{<\s*figure\s+([^>]*?)\/?>\}\}/g, (_m, rawAttrs: string) => {
    const attrs = parseAttrs(rawAttrs);
    const label = attrs.caption || attrs.alt;
    return label ? `\n*Figure: ${label}*\n` : "";
  });

  // --- skew (self-closing; arg may be bare or quoted) ---
  out = out.replace(
    new RegExp(`${OPEN}\\s*skew\\s+([^%<>]*?)${CLOSE}`, "g"),
    (_m, rawArgs: string) => {
      const tokens = rawArgs.trim().split(/\s+/).map((t) => t.replace(/^"|"$/g, ""));
      const mode = tokens[0];
      switch (mode) {
        case "currentVersion":
          return "the current Kubernetes version";
        case "currentPatchVersion":
          return "the current patch version";
        case "prevMinorVersion":
          return "the previous minor version";
        case "nextMinorVersion":
          return "the next minor version";
        case "currentVersionAddMinor": {
          const sign = tokens[1] ?? "";
          return sign.startsWith("-") ? "an earlier minor version" : "a later minor version";
        }
        default:
          return "";
      }
    },
  );

  // --- param (self-closing) ---
  out = out.replace(
    new RegExp(`${OPEN}\\s*param\\s+"([^"]*)"\\s*${CLOSE}`, "g"),
    (_m, name: string) => (name === "version" ? `v${K8S_VERSION}` : ""),
  );

  // --- version-check (self-closing) ---
  out = out.replace(new RegExp(`${OPEN}\\s*version-check\\s*${CLOSE}`, "g"), "");

  // --- ref / relref (self-closing) ---
  out = out.replace(
    /\{\{<\s*relref\s+"([^"]*)"\s*>\}\}/g,
    (m, arg: string) => resolveRef(arg, ctx.currentDir, ctx.pathIndex) ?? m,
  );
  out = out.replace(
    /\{\{<\s*ref\s+"([^"]*)"\s*>\}\}/g,
    (m, arg: string) => resolveRef(arg, ctx.currentDir, ctx.pathIndex) ?? m,
  );

  // --- standalone include (self-closing) ---
  out = out.replace(
    new RegExp(`${OPEN}\\s*include\\s+"([^"]*)"\\s*${CLOSE}`, "g"),
    (_m, arg: string) => {
      const content = readInclude(arg, ctx);
      if (content === null) {
        ctx.missingIncludes.add(arg);
        return "";
      }
      return `\n${content}\n`;
    },
  );

  return out;
}

export function normalizeBody(rawBody: string, ctx: NormalizeContext): string {
  let text = rawBody;
  // Run the full set of dedicated handlers to a fixed point first. This matters
  // for content spliced in by `include`/`tab include=` resolution: a freshly
  // inlined fragment may itself contain shortcodes (e.g. a nested `{{< tabs >}}`)
  // that need another pass to resolve. Only once nothing changes anymore do we
  // apply the catch-all strip below — running it inside every pass would consume
  // newly spliced-in shortcodes before their dedicated handler ever saw them.
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = normalizeOnce(text, ctx);
    if (next === text) break;
    text = next;
  }

  text = text.replace(/\{\{[%<]\s*\/?\s*([\w-]+)[^%>]*[%>]\}\}/g, (_m, tag: string) => {
    ctx.unmatchedTags.add(tag);
    return "";
  });

  return text
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}
