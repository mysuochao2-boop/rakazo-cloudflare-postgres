import type { MouseEvent, ReactNode } from "react";
import { createContext, memo, useCallback, useContext, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { HastNode } from "./table-utils";
import "./markdown.web.css";
import "./markdown-table.css";
import { droppedTableHtmlText } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@rakazo/ui-web";
import { CheckIcon, CloseIcon, CopyIcon, DownloadIcon, GlobeIcon, ImageIcon } from "./icons";
import type { ChatMarkdownProps } from "./markdown";
import {
  closeUnterminatedFence,
  fenceInlineSvgBlocks,
  inlineMarkdownImageSrc,
  inlineSvgDataUrl,
  inlineSvgRejection,
  LinkFaviconsPausedContext,
  linkFaviconOrigin,
  linkLabel,
  markdownLinkDisplayParts,
  markdownLinkRequiresConfirmation,
  markRemoteImageLoaded,
  plainTextLinkParts,
  RemoteImagesContext,
  remoteImageRenders,
  remoteMarkdownImage,
  sanitizeMarkdownUrl,
  svgSourceImage,
  useLinkFavicon,
} from "./markdown";
import { useMarkdownLinkCopy } from "./markdown-link-prompt";
import { MarkdownTable, MarkdownTableSourceContext } from "./markdown-table";

function preserveSkippedTableText() {
  return (tree: HastNode) => {
    const walk = (node: HastNode, inTableCell = false) => {
      const insideCell = inTableCell || node.tagName === "th" || node.tagName === "td";
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (insideCell && child.type === "raw") {
          const value = droppedTableHtmlText(child.value ?? "");
          return value === null ? child : { type: "text", value };
        }
        walk(child, insideCell);
        return child;
      });
    };
    walk(tree);
  };
}

function CodeBlock(props: React.ComponentPropsWithoutRef<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const resetTimerRef = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard) return;
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="rk-chat-markdown-pre-wrap">
      <pre {...props} ref={preRef} />
      <button
        type="button"
        className="rk-chat-markdown-copy"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

type EnclosingLink = false | "open" | "rejected";

const InsideLinkContext = createContext<EnclosingLink>(false);

const ConfirmLinkContext = createContext<(url: string) => void>(() => undefined);

function pageOrigin() {
  if (typeof window === "undefined") return null;
  const origin = window.location.origin;
  return origin && origin !== "null" ? origin : null;
}

function holdExternalLink(event: MouseEvent<HTMLAnchorElement>, request: (url: string) => void) {
  if (event.button !== 0 && event.button !== 1) return;
  const destination = event.currentTarget.href;
  if (!destination || !markdownLinkRequiresConfirmation(destination, pageOrigin())) return;
  event.preventDefault();
  request(destination);
}

function ExternalLinkUrl({ url }: { url: string }) {
  const parts = markdownLinkDisplayParts(url);
  if (!parts) return url;
  return (
    <>
      {parts.before}
      <strong className="font-semibold">{parts.host}</strong>
      {parts.after}
    </>
  );
}

function ExternalLinkAlert({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  const copy = useMarkdownLinkCopy();
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription className="break-all text-left text-foreground">
            <ExternalLinkUrl url={url} />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              window.open(url, "_blank", "noopener,noreferrer");
              onDismiss();
            }}
          >
            {copy.open}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function useExternalLinkConfirm() {
  const [url, setUrl] = useState<string | null>(null);
  const request = useCallback((destination: string) => {
    setUrl(destination);
  }, []);
  const dialog = url ? <ExternalLinkAlert url={url} onDismiss={() => setUrl(null)} /> : null;
  return { request, dialog };
}

function ConfirmableAnchor({ href, ...props }: React.ComponentPropsWithoutRef<"a">) {
  const request = useContext(ConfirmLinkContext);
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => holdExternalLink(event, request)}
      onAuxClick={(event) => holdExternalLink(event, request)}
    />
  );
}

type MarkdownHast = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownHast[];
};

function hastString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function linkHost(href: string): string {
  try {
    return new URL(href).host || href;
  } catch {
    return href;
  }
}

function soleRemoteImage(node: MarkdownHast | undefined):
  | {
      href: string;
      host: string;
      alt?: string;
      title?: string;
    }
  | undefined {
  const parts = (node?.children ?? []).filter((child) => {
    if (child.type === "text") return Boolean(child.value?.trim());
    return child.type === "element";
  });
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only?.tagName !== "img") return undefined;
  const remote = remoteMarkdownImage(hastString(only.properties?.src) ?? "");
  if (!remote) return undefined;
  return {
    ...remote,
    alt: hastString(only.properties?.alt),
    title: hastString(only.properties?.title),
  };
}

function RemoteImageButton({
  image,
  alt,
  title,
  onLoad,
}: {
  image: { href: string; host: string };
  alt?: string;
  title?: string;
  onLoad: () => void;
}) {
  return (
    <button
      type="button"
      className="rk-chat-markdown-image"
      title={title}
      onClick={() => {
        markRemoteImageLoaded(image.href);
        onLoad();
      }}
    >
      <ImageIcon />
      {alt ? <span>{alt}</span> : null}
      <span className="rk-chat-markdown-image-host">{image.host}</span>
    </button>
  );
}

function MarkdownImage({ src = "", alt, title }: { src?: string; alt?: string; title?: string }) {
  const enclosingLink = useContext(InsideLinkContext);
  const loadRemote = useContext(RemoteImagesContext);
  const remote = remoteMarkdownImage(src);
  // Bumping this redraws after a tap. Whether the image shows is read from the current URL.
  const [, setRevision] = useState(0);
  const rejectedLink = enclosingLink === "rejected";
  const svg = inlineSvgDataUrl(src);
  if (svg) {
    if (enclosingLink !== false) {
      return <img src={svg.src} alt={alt ?? ""} title={title} loading="lazy" />;
    }
    return (
      <ZoomableImage
        src={svg.src}
        alt={alt}
        title={title}
        svg
        download={() => ({ blob: svgBlob(svg.source), name: "image.svg" })}
      />
    );
  }
  if (inlineMarkdownImageSrc(src)) {
    if (enclosingLink !== false) {
      return <img src={src} alt={alt ?? ""} title={title} loading="lazy" />;
    }
    return (
      <ZoomableImage src={src} alt={alt} title={title} download={() => dataUrlDownload(src)} />
    );
  }
  if (remote && remoteImageRenders(remote.href, loadRemote, rejectedLink)) {
    return (
      <img
        src={remote.href}
        alt={alt ?? ""}
        title={title}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  if (!remote || enclosingLink !== false) return alt || remote?.host || src;
  return (
    <RemoteImageButton
      image={remote}
      alt={alt}
      title={title}
      onLoad={() => setRevision((revision) => revision + 1)}
    />
  );
}

function svgBlob(source: string): Blob {
  return new Blob([source], { type: "image/svg+xml" });
}

/** A base64 raster data: URL (already checked by inlineMarkdownImageSrc) as a download. */
function dataUrlDownload(src: string): ImageDownload {
  const comma = src.indexOf(",");
  const type = src.slice(5, src.indexOf(";")).toLowerCase();
  const binary = atob(src.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const extension = type.split("/")[1]?.replace("jpeg", "jpg") ?? "img";
  return { blob: new Blob([bytes], { type }), name: `image.${extension}` };
}

type ImageDownload = { blob: Blob; name: string };

function saveDownload({ blob, name }: ImageDownload) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** An inline image that opens larger, with a download button, when clicked. */
function ZoomableImage({
  src,
  alt,
  title,
  svg = false,
  download,
  onError,
}: {
  src: string;
  alt?: string;
  title?: string;
  svg?: boolean;
  download: () => ImageDownload;
  onError?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const label = alt || (svg ? "SVG image" : "Image");
  const imageClass = svg ? "rk-chat-markdown-svg-image" : undefined;
  return (
    <>
      <button
        type="button"
        className="rk-chat-markdown-zoom"
        aria-label={`Enlarge ${label}`}
        title={title}
        onClick={() => setOpen(true)}
      >
        <img src={src} alt={alt ?? ""} loading="lazy" className={imageClass} onError={onError} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-auto max-w-none bg-transparent p-0 ring-0 sm:max-w-none"
        >
          <DialogTitle className="sr-only">{label}</DialogTitle>
          <div className="rk-chat-markdown-lightbox">
            <div className="rk-chat-markdown-lightbox-actions">
              <button
                type="button"
                className="rk-chat-markdown-lightbox-button"
                aria-label="Download image"
                onClick={() => saveDownload(download())}
              >
                <DownloadIcon />
              </button>
              <DialogClose className="rk-chat-markdown-lightbox-button" aria-label="Close">
                <CloseIcon />
              </DialogClose>
            </div>
            <img
              src={src}
              alt={alt ?? ""}
              className={
                svg
                  ? "rk-chat-markdown-lightbox-image rk-chat-markdown-svg-image"
                  : "rk-chat-markdown-lightbox-image"
              }
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The text of a ```svg fence, or undefined for any other <pre>. */
function svgFenceSource(node: HastNode | undefined): string | undefined {
  const code = node?.children?.find((child) => child.type === "element");
  if (code?.tagName !== "code") return undefined;
  const className = (code.properties as { className?: unknown } | undefined)?.className;
  const classes = Array.isArray(className) ? className : [className];
  if (!classes.some((name) => typeof name === "string" && name.toLowerCase() === "language-svg")) {
    return undefined;
  }
  return (code.children ?? []).map((child) => child.value ?? "").join("");
}

/** A ```svg fence: the drawing by default, the code on request. */
function SvgCodeBlock({
  source,
  ...preProps
}: React.ComponentPropsWithoutRef<"pre"> & { source: string }) {
  const image = svgSourceImage(source);
  const [view, setView] = useState<"preview" | "source">("preview");
  const [failedSrc, setFailedSrc] = useState<string>();
  const failed = image !== undefined && failedSrc === image.src;
  const tooLarge = !image && inlineSvgRejection(source) === "too-large";
  const showPreview = image !== undefined && !failed && view === "preview";
  return (
    <div className="rk-chat-markdown-svg">
      {image && !failed ? (
        <div className="rk-chat-markdown-svg-tabs">
          <button
            type="button"
            aria-pressed={view === "preview"}
            onClick={() => setView("preview")}
          >
            Preview
          </button>
          <button type="button" aria-pressed={view === "source"} onClick={() => setView("source")}>
            Source
          </button>
        </div>
      ) : null}
      {showPreview ? (
        <ZoomableImage
          src={image.src}
          alt="SVG image"
          svg
          download={() => ({ blob: svgBlob(image.source), name: "image.svg" })}
          onError={() => setFailedSrc(image.src)}
        />
      ) : (
        <CodeBlock {...preProps} />
      )}
      {failed ? (
        <p className="rk-chat-markdown-svg-note">
          This SVG could not be drawn; showing its source.
        </p>
      ) : tooLarge ? (
        <p className="rk-chat-markdown-svg-note">
          This SVG is too large to preview; showing its source.
        </p>
      ) : null}
    </div>
  );
}

function LinkedRemoteImage({
  href,
  image,
  alt,
  title,
}: {
  href: string;
  image: { href: string; host: string };
  alt?: string;
  title?: string;
}) {
  const loadRemote = useContext(RemoteImagesContext);
  const [, setRevision] = useState(0);
  if (remoteImageRenders(image.href, loadRemote, false)) {
    return (
      <ConfirmableAnchor href={href}>
        <img
          src={image.href}
          alt={alt ?? ""}
          title={title}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </ConfirmableAnchor>
    );
  }
  return (
    <span className="rk-chat-markdown-linked-image">
      <RemoteImageButton
        image={image}
        alt={alt}
        title={title}
        onLoad={() => setRevision((revision) => revision + 1)}
      />
      <ConfirmableAnchor href={href}>{linkHost(href)}</ConfirmableAnchor>
    </span>
  );
}

/** The label when it is plain text, the only kind that can be a bare URL. */
function hastText(node: MarkdownHast | undefined): string | undefined {
  const children = node?.children ?? [];
  if (!children.every((child) => child.type === "text")) return undefined;
  return children.map((child) => child.value ?? "").join("");
}

function hastHasImage(node: MarkdownHast | undefined): boolean {
  return (node?.children ?? []).some((child) => child.tagName === "img" || hastHasImage(child));
}

function LinkFavicon({ href }: { href: string }) {
  const { icon, unusable } = useLinkFavicon(href);
  return (
    <span
      aria-hidden="true"
      className={icon ? "rk-chat-link-tile rk-chat-link-tile-icon" : "rk-chat-link-tile"}
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          draggable={false}
          onLoad={(event) => {
            // A 1×1 image is a tracking pixel, not an icon.
            const image = event.currentTarget;
            if (image.naturalWidth <= 1 || image.naturalHeight <= 1) unusable();
          }}
          onError={unusable}
        />
      ) : (
        <GlobeIcon />
      )}
    </span>
  );
}

/** A link to a website, drawn with its site icon before the label. */
function WebsiteLink({
  href,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"a"> & { href: string; children: ReactNode }) {
  return (
    <ConfirmableAnchor {...props} href={href} className="rk-chat-link">
      <LinkFavicon href={href} />
      {/* bdi: direction characters in a label cannot reorder the text around the link. */}
      <bdi className="rk-chat-link-label">{children}</bdi>
    </ConfirmableAnchor>
  );
}

function MarkdownAnchor({
  node,
  ...props
}: React.ComponentPropsWithoutRef<"a"> & { node?: MarkdownHast }) {
  const loadRemote = useContext(RemoteImagesContext);
  const href = typeof props.href === "string" ? props.href : "";
  const image = href ? soleRemoteImage(node) : undefined;
  if (image && !remoteImageRenders(image.href, loadRemote, false)) {
    return <LinkedRemoteImage href={href} image={image} alt={image.alt} title={image.title} />;
  }
  // urlTransform blanks unsafe URLs. Keep their text without a link that opens the app again.
  const opens = Boolean(props.href);
  const text = hastText(node);
  const link =
    opens && linkFaviconOrigin(href) && !hastHasImage(node) ? (
      <WebsiteLink {...props} href={href}>
        {text === undefined ? props.children : linkLabel(text, href)}
      </WebsiteLink>
    ) : opens ? (
      <ConfirmableAnchor {...props} />
    ) : (
      <span>{props.children}</span>
    );
  return (
    <InsideLinkContext.Provider value={opens ? "open" : "rejected"}>
      {link}
    </InsideLinkContext.Provider>
  );
}

const components: Components = {
  a: MarkdownAnchor,
  img({ node: _node, src, alt, title }) {
    return (
      <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} title={title} />
    );
  },
  pre({ node, ...props }) {
    const svg = svgFenceSource(node as HastNode | undefined);
    if (svg !== undefined) return <SvgCodeBlock source={svg} {...props} />;
    return <CodeBlock {...props} />;
  },
  table({ node, children, ...props }) {
    return (
      <MarkdownTable node={node} tableProps={props}>
        {children}
      </MarkdownTable>
    );
  },
};

export function LinkifiedText({ children }: { children: string }) {
  const { request, dialog } = useExternalLinkConfirm();
  return (
    <ConfirmLinkContext.Provider value={request}>
      {plainTextLinkParts(children).map((part, index) =>
        part.type === "text" ? (
          part.value
        ) : linkFaviconOrigin(part.href) ? (
          <WebsiteLink key={index} href={part.href}>
            {linkLabel(part.value, part.href)}
          </WebsiteLink>
        ) : (
          <ConfirmableAnchor key={index} href={part.href} className="text-link underline">
            {part.value}
          </ConfirmableAnchor>
        ),
      )}
      {dialog}
    </ConfirmLinkContext.Provider>
  );
}

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
}: ChatMarkdownProps) {
  const { request, dialog } = useExternalLinkConfirm();
  const withSvg = fenceInlineSvgBlocks(children);
  const source = streaming ? closeUnterminatedFence(withSvg) : withSvg;

  return (
    <ConfirmLinkContext.Provider value={request}>
      <div
        className={streaming ? "rk-chat-markdown rk-chat-markdown-streaming" : "rk-chat-markdown"}
      >
        <LinkFaviconsPausedContext.Provider value={streaming}>
          <MarkdownTableSourceContext.Provider value={source}>
            <ReactMarkdown
              components={components}
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[preserveSkippedTableText]}
              skipHtml
              // MarkdownImage decides what an image source may do, so it receives the source as written.
              urlTransform={(url, key) =>
                key === "src" ? url : (sanitizeMarkdownUrl(url, true) ?? "")
              }
            >
              {source}
            </ReactMarkdown>
          </MarkdownTableSourceContext.Provider>
        </LinkFaviconsPausedContext.Provider>
        {streaming ? <span aria-hidden="true" className="rk-chat-markdown-cursor" /> : null}
      </div>
      {dialog}
    </ConfirmLinkContext.Provider>
  );
});

export type { ChatMarkdownProps, LinkFavicons } from "./markdown";
export { LinkFaviconsContext, RemoteImagesContext } from "./markdown";

export { MarkdownLinkPromptProvider } from "./markdown-link-prompt";
