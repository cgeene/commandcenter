/**
 * Pure, dependency-free helper for rendering agent-authored prose as markdown.
 * Lives in src/lib so it can be BOTH unit-tested under node AND bundled into
 * the web dashboard (imported via a relative path), same as board.ts/panel.ts.
 *
 * Fields like task.prompt/result_summary/review_notes are markdown-ish but not
 * guaranteed valid markdown — in particular they're often plain prose with
 * single newlines that CommonMark collapses into a space inside a paragraph.
 * softenLineBreaks rewrites those into hard breaks (trailing double-space)
 * so react-markdown renders them as visible line breaks, without touching
 * fenced code blocks (where inserted trailing whitespace would be visible
 * and unwanted) or already-blank-line-separated paragraphs.
 */
export function softenLineBreaks(content: string): string {
  const parts = content.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/([^\n])\n(?!\n)/g, "$1  \n")))
    .join("");
}
