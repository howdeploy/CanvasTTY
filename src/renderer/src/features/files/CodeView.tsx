import { highlightCode } from "./codeHighlight.ts";

export interface CodeViewProps {
  content: string;
  language: string | null;
}

/**
 * Renders code with lowlight highlighting for registered languages and falls
 * back to plain monospace text for unknown languages.
 */
export function CodeView({ content, language }: CodeViewProps): React.JSX.Element {
  const highlighted = highlightCode(content, language);
  return (
    <pre className="file-browser-card__viewer-text file-browser-card__code">
      <code>{highlighted ?? content}</code>
    </pre>
  );
}
