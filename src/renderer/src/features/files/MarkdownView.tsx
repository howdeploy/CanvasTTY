import type { JSX } from "react";
import { createMarkdownElement } from "./markdownPipeline.ts";

export interface MarkdownViewProps {
  content: string;
  onOpenLink?: (href: string) => void;
}

export function MarkdownView({ content, onOpenLink }: MarkdownViewProps): JSX.Element {
  return (
    <div className="file-browser-card__markdown">{createMarkdownElement(content, onOpenLink)}</div>
  );
}
