/**
 * Tiny, dependency-free YAML frontmatter support for the doc store.
 *
 * Lives in src/lib so it can be BOTH unit-tested under node AND bundled into
 * the web dashboard (imported via a relative path). It must not import
 * anything node- or db-specific.
 *
 * This is deliberately NOT a general YAML implementation: it only emits/parses
 * the flat set of scalar and string-list fields the doc store uses. The parser
 * is tolerant — anything it does not recognize is skipped rather than throwing.
 */

export type FrontmatterValue = string | number | string[] | null | undefined;

export interface DocFrontmatter {
  [key: string]: string | string[];
}

export interface ParsedDoc {
  data: DocFrontmatter;
  /** Everything after the closing `---` line (the doc body). */
  body: string;
}

/**
 * Render an ordered list of fields as a `---`-delimited YAML frontmatter block
 * (trailing newline included). `null`/`undefined` values and empty lists are
 * skipped so absent metadata never emits an empty key.
 */
export function emitFrontmatter(
  entries: Array<[string, FrontmatterValue]>,
): string {
  const lines: string[] = ["---"];
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
    } else if (typeof value === "number") {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/** Split leading frontmatter from a document, parsing the known fields. */
export function parseFrontmatter(content: string): ParsedDoc {
  const { yaml, body } = splitFrontmatter(content);
  if (yaml === null) return { data: {}, body: content };
  return { data: parseYamlBlock(yaml), body };
}

/** Return just the document body, with any leading frontmatter removed. */
export function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

/** True when `content` begins with a well-formed `---` frontmatter block. */
export function hasFrontmatter(content: string): boolean {
  return splitFrontmatter(content).yaml !== null;
}

// --- internals -------------------------------------------------------------

/**
 * Locate a leading frontmatter block. It must start on the very first line
 * (`---`) and be closed by a later line that is exactly `---`. Returns the raw
 * YAML text (delimiters excluded) and the body after it, or `yaml: null` when
 * there is no valid block — a bare `---` horizontal rule in prose is left alone.
 */
function splitFrontmatter(content: string): { yaml: string | null; body: string } {
  const open = /^---[ \t]*\r?\n/.exec(content);
  if (!open) return { yaml: null, body: content };
  const afterOpen = content.slice(open[0].length);
  // A closing delimiter is a `---` line either at the very start (empty
  // frontmatter) or preceded by a newline.
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(afterOpen);
  if (!close) return { yaml: null, body: content };
  const yaml = afterOpen.slice(0, close.index);
  const body = afterOpen.slice(close.index + close[0].length);
  return { yaml, body };
}

function parseYamlBlock(yaml: string): DocFrontmatter {
  const data: DocFrontmatter = {};
  let listKey: string | null = null;
  let list: string[] = [];
  const flush = () => {
    if (listKey !== null) {
      data[listKey] = list;
      listKey = null;
      list = [];
    }
  };
  for (const line of yaml.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey !== null) {
      list.push(unquote(item[1].trim()));
      continue;
    }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) continue; // tolerant: ignore anything we don't recognize
    flush();
    const val = kv[2].trim();
    if (val === "") {
      listKey = kv[1]; // may begin a block list on the following lines
      list = [];
    } else {
      data[kv[1]] = unquote(val);
    }
  }
  flush();
  return data;
}

function yamlScalar(raw: string): string {
  const s = String(raw);
  if (s === "" || needsQuoting(s)) {
    return `"${s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")}"`;
  }
  return s;
}

function needsQuoting(s: string): boolean {
  if (s !== s.trim()) return true; // leading/trailing whitespace
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true; // YAML indicator start char
  if (/: |:$| #/.test(s)) return true; // colon-space, trailing colon, or comment
  if (/[\n\t]/.test(s)) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true; // bool/null-like
  if (/^[+-]?(\d[\d_]*)(\.\d*)?([eE][+-]?\d+)?$/.test(s)) return true; // number-like
  return false;
}

function unquote(s: string): string {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return unescapeDouble(s.slice(1, -1));
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

/** Reverse the double-quote escaping done by yamlScalar, in a single pass. */
function unescapeDouble(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const n = s[++i];
      out += n === "n" ? "\n" : n === "t" ? "\t" : n;
    } else {
      out += s[i];
    }
  }
  return out;
}
