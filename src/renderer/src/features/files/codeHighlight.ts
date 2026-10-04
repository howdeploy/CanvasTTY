import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { COMMON_LANGUAGES } from "./fileLanguage.ts";

/**
 * Deterministic code highlighting for the file viewer. This module carries no
 * JSX so it can be imported directly by node:test; the matching React wrapper
 * lives in `CodeView.tsx`.
 *
 * The lowlight instance registers the curated `common` set (not `all`) because
 * `COMMON_LANGUAGES` in `fileLanguage.ts` is constrained to that set.
 */
const lowlight = createLowlight(common);

// Invariant relied on by detection: every id `detectFileLanguage` can return is
// registered here, so a detected language is never silently unhighlighted.
const missingLanguages = COMMON_LANGUAGES.filter((language) => !lowlight.registered(language));
if (missingLanguages.length > 0) {
  throw new Error(`lowlight is missing registered languages: ${missingLanguages.join(", ")}`);
}

/** True when `language` names a non-empty language registered by lowlight. */
export function isRegisteredLanguage(language: string | null | undefined): boolean {
  if (typeof language !== "string" || language.length === 0) return false;
  return lowlight.registered(language);
}

/**
 * Highlights `content` as `language`, returning a React element, or null when
 * the language is missing or unregistered (callers fall back to plain text).
 */
export function highlightCode(
  content: string,
  language: string | null | undefined
): ReactElement | null {
  if (!isRegisteredLanguage(language)) return null;
  const tree = lowlight.highlight(language as string, content);
  return toJsxRuntime(tree, { Fragment, jsx, jsxs });
}
