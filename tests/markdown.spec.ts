import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

/**
 * Markdown→HTML is used by the Shelf reader and the chapter Preview. It must
 * never emit a link to a protocol-relative target (`//evil`) — that is an
 * open redirect, not a site path — and it must escape all HTML.
 */
describe("markdown link sanitization + escaping", () => {
  it("keeps normal relative, absolute, mailto and anchor links", () => {
    expect(renderMarkdown("[a](/story)")).toContain('href="/story"');
    expect(renderMarkdown("[a](https://x.example/y)")).toContain('href="https://x.example/y"');
    expect(renderMarkdown("[a](mailto:x@example.com)")).toContain('href="mailto:x@example.com"');
    expect(renderMarkdown("[a](#sec)")).toContain('href="#sec"');
  });

  it("neutralizes protocol-relative // targets (open redirect)", () => {
    const out = renderMarkdown("[click](//evil.example/phish)");
    expect(out).not.toContain("//evil.example");
    expect(out).toContain('href="#"');
  });

  it("neutralizes javascript: targets", () => {
    const out = renderMarkdown("[x](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="#"');
  });

  it("escapes HTML in body and link text", () => {
    const out = renderMarkdown("hi <script>alert(1)</script> and [tag](/x)");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain('href="/x"');
  });
});
