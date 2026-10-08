import { createElement } from "react";
import type { MouseEvent, ReactElement } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import type { Components, UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { isEmbeddedImageSource, isOpenableLink } from "./fileLinks.ts";

/**
 * Sanitization schema for rendered Markdown. Extends the GitHub-style default
 * schema only to preserve syntax-highlight class names produced by
 * `rehype-highlight` and to let embedded `data:image/...` sources reach the
 * image component. Script stripping and dangerous protocols (`javascript:`,
 * etc.) are left untouched.
 */
export const markdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["className", "hljs", /^hljs-/, /^language-/]],
    code: [...(defaultSchema.attributes?.code ?? []), ["className", "hljs", /^hljs-/, /^language-/]]
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"]
  }
};

/**
 * Keeps embedded data-image sources so the `img` component can accept them,
 * while delegating every other URL to react-markdown's safe default (which
 * drops `javascript:` and other dangerous protocols).
 */
const markdownUrlTransform: UrlTransform = (value) => {
  if (isEmbeddedImageSource(value)) return value;
  return defaultUrlTransform(value);
};

/**
 * Builds a React element that renders sanitized Markdown. Raw HTML is never
 * enabled (no `rehype-raw`); links are routed through `onOpenLink` only when
 * they are absolute http(s) URLs, and images render only when they are embedded
 * data URLs.
 */
export function createMarkdownElement(
  content: string,
  onOpenLink?: (href: string) => void
): ReactElement {
  const components: Components = {
    a({ href, children }) {
      if (isOpenableLink(href)) {
        const target = href as string;
        return createElement(
          "a",
          {
            href: target,
            target: "_blank",
            rel: "noreferrer noopener",
            onClick: (event: MouseEvent<HTMLAnchorElement>) => {
              event.preventDefault();
              onOpenLink?.(target);
            }
          },
          children
        );
      }
      return createElement("span", { className: "file-browser-card__markdown-inert" }, children);
    },
    img({ src, alt }) {
      if (isEmbeddedImageSource(src)) {
        return createElement("img", { src, alt });
      }
      return createElement(
        "span",
        { className: "file-browser-card__markdown-image-placeholder" },
        alt || "image"
      );
    }
  };

  return createElement(
    Markdown,
    {
      remarkPlugins: [remarkGfm],
      rehypePlugins: [rehypeHighlight, [rehypeSanitize, markdownSanitizeSchema]],
      urlTransform: markdownUrlTransform,
      components
    },
    content
  );
}
