/**
 * Small markdown→HTML renderer for the Shelf reader (frontend doc §3.5:
 * "small md→html renderer server-side"). Covers the subset an author uses:
 * headings, bold/italic/code, links, lists, blockquotes, hr, paragraphs,
 * newlines. Everything is HTML-escaped first — no raw html injection.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s: string): string {
  let out = escapeHtml(s);
  // inline code first (protect from other rules)
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  // bold
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // italic
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_\w])_([^_\s][^_]*)_/g, "$1<em>$2</em>");
  // links [text](target) — targets sanitized. Note the `//` exclusion:
  // `//evil.example` is protocol-relative (a redirect/leak), not a path.
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, text, target) => {
    const safe =
      !target.startsWith("//") && /^(https?:\/\/|mailto:|#|\/)/i.test(target) ? target : "#";
    return `<a href="${safe}">${text}</a>`;
  });
  return out;
}

export function renderMarkdown(md: string): string {
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  let quote: string[] | null = null;

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote) {
      html.push(`<blockquote>${quote.map((q) => `<p>${inline(q)}</p>`).join("")}</blockquote>`);
      quote = null;
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed === "") {
      flushAll();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushAll();
      const level = h[1].length;
      html.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      flushAll();
      html.push("<hr>");
      continue;
    }
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      flushQuote();
      (list ??= []).push(li[1]);
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      flushQuote();
      (list ??= []).push(ol[1]);
      continue;
    }
    const q = /^>\s?(.*)$/.exec(trimmed);
    if (q) {
      flushPara();
      flushList();
      (quote ??= []).push(q[1]);
      continue;
    }
    flushList();
    flushQuote();
    para.push(trimmed);
  }
  flushAll();
  return html.join("\n");
}
