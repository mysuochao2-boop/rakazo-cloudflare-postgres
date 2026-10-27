// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_INLINE_SVG_BYTES } from "./markdown";
import { ChatMarkdown } from "./markdown.web";

const CIRCLE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="4"/></svg>';
const SVG_SRC = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(CIRCLE)}`;

async function mount(markdown: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ChatMarkdown>{markdown}</ChatMarkdown>);
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function buttonNamed(container: ParentNode, name: string) {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === name || button.getAttribute("aria-label") === name,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("web markdown svg", () => {
  it("draws an svg fence as an image and toggles to its source", async () => {
    const view = await mount(`\`\`\`svg\n${CIRCLE}\n\`\`\``);
    const image = view.container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(SVG_SRC);
    expect(view.container.querySelector("pre")).toBeNull();
    expect(buttonNamed(view.container, "Preview")?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => buttonNamed(view.container, "Source")?.click());
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("pre code")?.textContent).toBe(`${CIRCLE}\n`);

    await act(async () => buttonNamed(view.container, "Preview")?.click());
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(SVG_SRC);
    await view.unmount();
  });

  it("falls back to the source when the browser cannot draw the svg", async () => {
    const view = await mount(`\`\`\`svg\n${CIRCLE}\n\`\`\``);
    await act(async () => {
      view.container.querySelector("img")?.dispatchEvent(new Event("error"));
    });
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("pre")).not.toBeNull();
    expect(view.container.textContent).toContain("could not be drawn");
    await view.unmount();
  });

  it("shows oversized or incomplete svg as source only", () => {
    const big = `<svg>${" ".repeat(MAX_INLINE_SVG_BYTES)}</svg>`;
    const oversized = renderToStaticMarkup(
      <ChatMarkdown>{`\`\`\`svg\n${big}\n\`\`\``}</ChatMarkdown>,
    );
    expect(oversized).not.toContain("<img");
    expect(oversized).toContain("<pre");
    expect(oversized).toContain("too large to preview");
    const partial = renderToStaticMarkup(
      <ChatMarkdown streaming>{"```svg\n<svg><circle r='4'/>"}</ChatMarkdown>,
    );
    expect(partial).not.toContain("<img");
    expect(partial).not.toContain("Preview");
  });

  it("draws raw svg in a reply instead of dropping it", () => {
    const html = renderToStaticMarkup(<ChatMarkdown>{`Here:\n${CIRCLE}\nDone`}</ChatMarkdown>);
    expect(html).toContain(`src="${SVG_SRC.replaceAll("&", "&amp;")}"`);
    expect(html).toContain("Here:");
    expect(html).toContain("Done");
  });

  it("never puts svg markup or scripts into the page", async () => {
    const hostile =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwned=1">' +
      "<script>window.__pwned=2</script>" +
      '<foreignObject><img src="x" onerror="window.__pwned=3"></foreignObject></svg>';
    const view = await mount(`Look:\n${hostile}\n\n\`\`\`svg\n${hostile}\n\`\`\``);
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector("foreignObject, [onload], [onerror]")).toBeNull();
    // Only the markdown's own icons are inline svg; the reply's svg is an <img> data url.
    const inlineSvg = [...view.container.querySelectorAll("svg")];
    expect(inlineSvg.every((svg) => svg.getAttribute("aria-hidden") === "true")).toBe(true);
    const images = [...view.container.querySelectorAll("img")];
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.getAttribute("src")?.startsWith("data:image/svg+xml;charset=utf-8,%3Csvg")).toBe(
        true,
      );
    }
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    await view.unmount();
  });

  it("renders base64 and url-encoded svg data images", () => {
    const encoded = Buffer.from(CIRCLE).toString("base64");
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {`![a](data:image/svg+xml;base64,${encoded}) ![b](data:image/svg+xml,${encodeURIComponent(CIRCLE)})`}
      </ChatMarkdown>,
    );
    const src = `src="${SVG_SRC.replaceAll("&", "&amp;")}"`;
    expect(html.split(src)).toHaveLength(3);
    expect(html).toContain('alt="a"');
    expect(html).toContain('alt="b"');
  });

  it("opens an svg larger and downloads it as an .svg blob", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:svg");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const view = await mount(`\`\`\`svg\n${CIRCLE}\n\`\`\``);
    await act(async () => buttonNamed(view.container, "Enlarge SVG image")?.click());
    const download = buttonNamed(document.body, "Download image");
    expect(document.body.querySelectorAll(`img[src="${SVG_SRC}"]`)).toHaveLength(2);
    await act(async () => download?.click());

    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe("image.svg");
    expect(clicked[0]?.getAttribute("href")).toBe("blob:svg");
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toBe("image/svg+xml");
    expect(await blob?.text()).toBe(CIRCLE);
    await view.unmount();
  });

  it("downloads an inline raster image with its own type", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:png");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const view = await mount("![dot](data:image/png;base64,iVBORw0KGgo=)");
    await act(async () => buttonNamed(view.container, "Enlarge dot")?.click());
    await act(async () => buttonNamed(document.body, "Download image")?.click());
    expect(clicked[0]?.download).toBe("image.png");
    expect(createObjectURL.mock.calls[0]?.[0].type).toBe("image/png");
    await view.unmount();
  });
});
