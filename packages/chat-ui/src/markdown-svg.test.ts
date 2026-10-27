import { describe, expect, it } from "vitest";
import {
  fenceInlineSvgBlocks,
  inlineMarkdownImageSrc,
  inlineSvgDataUrl,
  inlineSvgRejection,
  MAX_INLINE_SVG_BYTES,
  svgSourceImage,
} from "./markdown";

const CIRCLE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="4"/></svg>';

function base64(text: string) {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("svgSourceImage", () => {
  it("draws a complete svg document through an encoded data url", () => {
    const image = svgSourceImage(`\n${CIRCLE}\n`);
    expect(image?.source).toBe(CIRCLE);
    expect(image?.src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(CIRCLE)}`);
    expect(svgSourceImage(`<?xml version="1.0"?>\n<!-- logo -->\n${CIRCLE}`)).toBeDefined();
  });

  it("keeps anything that is not one svg document as source", () => {
    expect(svgSourceImage("")).toBeUndefined();
    expect(svgSourceImage("<svg><circle r='4'/>")).toBeUndefined();
    expect(svgSourceImage(`<div>${CIRCLE}</div>`)).toBeUndefined();
    expect(svgSourceImage(`<svgx>${CIRCLE}`)).toBeUndefined();
    expect(
      svgSourceImage(`<!DOCTYPE svg [<!ENTITY a "aaaa">]>${CIRCLE}`),
      "internal doctype subsets can expand entities",
    ).toBeUndefined();
  });

  it("caps the source at 512KB of UTF-8", () => {
    const fits = `<svg>${" ".repeat(MAX_INLINE_SVG_BYTES - 11)}</svg>`;
    expect(new TextEncoder().encode(fits).length).toBe(MAX_INLINE_SVG_BYTES);
    expect(svgSourceImage(fits)).toBeDefined();
    const over = `<svg>${" ".repeat(MAX_INLINE_SVG_BYTES - 12)}é</svg>`;
    expect(over.length).toBe(MAX_INLINE_SVG_BYTES);
    expect(svgSourceImage(over)).toBeUndefined();
    expect(inlineSvgRejection(over)).toBe("too-large");
    expect(inlineSvgRejection("<svg>")).toBe("not-svg");
  });
});

describe("inlineSvgDataUrl", () => {
  it("reads base64 and percent-encoded svg data urls", () => {
    expect(inlineSvgDataUrl(`data:image/svg+xml;base64,${base64(CIRCLE)}`)?.source).toBe(CIRCLE);
    expect(
      inlineSvgDataUrl(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(CIRCLE)}`)?.source,
    ).toBe(CIRCLE);
    expect(inlineSvgDataUrl(`data:image/svg+xml;utf8,${CIRCLE}`)?.source).toBe(CIRCLE);
    const label = '<svg xmlns="http://www.w3.org/2000/svg"><text>图 100%</text></svg>';
    expect(inlineSvgDataUrl(`data:image/svg+xml;base64,${base64(label)}`)?.source).toBe(label);
    expect(inlineSvgDataUrl(`data:image/svg+xml,${label}`)?.source).toBe(label);
  });

  it("always hands the img a data url it built itself", () => {
    const image = inlineSvgDataUrl(`DATA:image/SVG+xml;base64,${base64(CIRCLE)}`);
    expect(image?.src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(CIRCLE)}`);
  });

  it("rejects other types, broken payloads and oversized svg", () => {
    expect(inlineSvgDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBeUndefined();
    expect(inlineSvgDataUrl("data:text/html,<svg></svg>")).toBeUndefined();
    expect(inlineSvgDataUrl("data:image/svg+xml;base64,@@@")).toBeUndefined();
    expect(inlineSvgDataUrl(`data:image/svg+xml;base64,${base64("<b>hi</b>")}`)).toBeUndefined();
    const big = `<svg>${"x".repeat(MAX_INLINE_SVG_BYTES)}</svg>`;
    expect(inlineSvgDataUrl(`data:image/svg+xml;base64,${base64(big)}`)).toBeUndefined();
  });

  it("leaves the native-shared raster helper without svg", () => {
    expect(inlineMarkdownImageSrc(`data:image/svg+xml;base64,${base64(CIRCLE)}`)).toBeUndefined();
  });
});

describe("fenceInlineSvgBlocks", () => {
  it("turns a raw svg block into an svg fence and keeps the text around it", () => {
    const markdown = `Here it is:\n<svg width="10">\n  <circle r="4"/>\n</svg> done\nBye`;
    expect(fenceInlineSvgBlocks(markdown)).toBe(
      'Here it is:\n```svg\n<svg width="10">\n  <circle r="4"/>\n</svg>\n```\n done\nBye',
    );
  });

  it("closes on the matching tag when svg elements nest", () => {
    const markdown = "<svg><svg><rect/></svg><svg/></svg>\nafter";
    expect(fenceInlineSvgBlocks(markdown)).toBe(
      "```svg\n<svg><svg><rect/></svg><svg/></svg>\n```\nafter",
    );
  });

  it("uses a fence longer than any backtick run inside the svg", () => {
    const markdown = "<svg><text>````code````</text></svg>";
    expect(fenceInlineSvgBlocks(markdown)).toBe(
      "`````svg\n<svg><text>````code````</text></svg>\n`````",
    );
  });

  it("leaves svg inside code fences, unclosed svg and mid-line svg alone", () => {
    const fenced = "```html\n<svg><circle/></svg>\n```\n~~~\n<svg></svg>\n~~~";
    expect(fenceInlineSvgBlocks(fenced)).toBe(fenced);
    const streaming = 'Drawing:\n<svg width="10">\n<circle';
    expect(fenceInlineSvgBlocks(streaming)).toBe(streaming);
    const midLine = "Use <svg></svg> tags.";
    expect(fenceInlineSvgBlocks(midLine)).toBe(midLine);
    const indented = "    <svg></svg>";
    expect(fenceInlineSvgBlocks(indented)).toBe(indented);
  });

  it("converts each block in a reply", () => {
    expect(fenceInlineSvgBlocks("<svg>a</svg>\ntext\n <svg>b</svg>")).toBe(
      "```svg\n<svg>a</svg>\n```\ntext\n```svg\n<svg>b</svg>\n```",
    );
  });
});
