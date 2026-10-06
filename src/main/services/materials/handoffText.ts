import type { LocaleId, RemarkAnchor, Size } from "../../../shared/contracts";
import { anchorRect } from "./imageRegions.ts";
import { formatClock } from "../../../shared/materials.ts";

export const HANDOFF_TEXT_LIMIT = 16_000;

export type HandoffImageMode = "claude" | "codex" | "paths";

export interface HandoffTextTarget {
  name: string;
  versionNumber: number;
  anchor: RemarkAnchor;
  natural: Size | null;
  file: string;
  marked: string | null;
  crop: string | null;
  location: string | null;
}

export interface HandoffTextRemark {
  number: number;
  text: string;
  target: HandoffTextTarget;
  reference: HandoffTextTarget | null;
}

export interface HandoffTextImage {
  name: string;
  path: string;
}

export interface HandoffTextInput {
  locale: LocaleId;
  number: number;
  folder: string;
  remarks: HandoffTextRemark[];
  editable: string[];
  note: string;
  resultsFolder: string | null;
  reportFile: string | null;
  imageMode: HandoffImageMode;
  images: HandoffTextImage[];
}

const STRINGS = {
  ru: {
    header: (number: number, count: number) => `CanvasTTY · передача #${number} · замечаний: ${count}`,
    folder: "Файлы передачи (снимки версий и выделения) лежат в папке:",
    editable: "Эти рабочие файлы можно менять:",
    onlyEditable: "Остальные файлы — только для справки, их не меняй.",
    noEditable: "Исходные файлы не меняй — новые варианты сохраняй отдельными файлами.",
    version: "версия",
    source: "Исходный файл:",
    snapshot: "Снимок версии:",
    marked: "Кадр с выделением:",
    crop: "Фрагмент крупно:",
    reference: "Референс:",
    requirement: "Требование:",
    note: "Дополнительно:",
    whole: "всё целиком",
    region: (rect: string, size: string) => `область ${rect} из ${size} px`,
    point: (x: number, y: number, size: string) => `точка (${x}, ${y}) из ${size} px`,
    regionShare: (x: string, y: string) => `область: по ширине ${x}, по высоте ${y}`,
    pointShare: (x: string, y: string) => `точка: по ширине ${x}, по высоте ${y}`,
    line: (line: number) => `строка ${line}`,
    lines: (start: number, end: number) => `строки ${start}–${end}`,
    moment: (time: string) => `момент ${time}`,
    pdfPage: (page: number) => `страница ${page}`,
    span: (start: string, end: string) => `отрезок ${start}–${end}`,
    finish: (numbers: string) => `Когда закончишь, ответь, какие замечания (${numbers}) считаешь исправленными и что изменил.`,
    results: "Новые файлы результата сохраняй в папку",
    resultsTail: "для проверки.",
    report: "Отчёт запиши в",
    reportShape: "в виде {\"fixed\":[номера],\"note\":\"что сделано\"}.",
    attached: "Приложенные изображения по порядку:",
    open: "Изображения (открой их):",
    pointer: (number: number) => `CanvasTTY · передача #${number}: полный текст замечаний в файле`,
    pointerTail: "— прочитай его целиком."
  },
  en: {
    header: (number: number, count: number) => `CanvasTTY · handoff #${number} · remarks: ${count}`,
    folder: "Handoff files (version snapshots and highlights) are in:",
    editable: "You may change these working files:",
    onlyEditable: "The other files are for reference only — do not change them.",
    noEditable: "Do not change the source files — save new variants as separate files.",
    version: "version",
    source: "Source file:",
    snapshot: "Version snapshot:",
    marked: "Frame with the highlight:",
    crop: "Close-up:",
    reference: "Reference:",
    requirement: "Requirement:",
    note: "Also:",
    whole: "the whole file",
    region: (rect: string, size: string) => `area ${rect} of ${size} px`,
    point: (x: number, y: number, size: string) => `point (${x}, ${y}) of ${size} px`,
    regionShare: (x: string, y: string) => `area ${x} across, ${y} down`,
    pointShare: (x: string, y: string) => `point ${x} across, ${y} down`,
    line: (line: number) => `line ${line}`,
    lines: (start: number, end: number) => `lines ${start}–${end}`,
    moment: (time: string) => `at ${time}`,
    pdfPage: (page: number) => `page ${page}`,
    span: (start: string, end: string) => `${start}–${end}`,
    finish: (numbers: string) => `When you are done, reply which remarks (${numbers}) you consider fixed and what you changed.`,
    results: "Save new result files into",
    resultsTail: "for review.",
    report: "Write the report to",
    reportShape: "as {\"fixed\":[numbers],\"note\":\"what was done\"}.",
    attached: "Attached images, in order:",
    open: "Images (open them):",
    pointer: (number: number) => `CanvasTTY · handoff #${number}: the full remarks are in`,
    pointerTail: "— read it completely."
  }
} as const;

export function describeAnchor(anchor: RemarkAnchor, natural: Size | null, locale: LocaleId): string {
  const strings = STRINGS[locale];
  if (anchor.kind === "lines") return anchor.start === anchor.end ? strings.line(anchor.start) : strings.lines(anchor.start, anchor.end);
  if (anchor.kind === "page") return strings.pdfPage(anchor.page);
  if (anchor.kind === "time") return anchor.end === null ? strings.moment(formatClock(anchor.start)) : strings.span(formatClock(anchor.start), formatClock(anchor.end));
  if (anchor.kind === "whole") return strings.whole;
  if (!natural) {
    return anchor.kind === "point"
      ? strings.pointShare(share(anchor.x), share(anchor.y))
      : strings.regionShare(`${share(anchor.x)}–${share(anchor.x + anchor.width)}`, `${share(anchor.y)}–${share(anchor.y + anchor.height)}`);
  }
  const size = `${natural.width}×${natural.height}`;
  if (anchor.kind === "point") {
    return strings.point(Math.round(anchor.x * natural.width), Math.round(anchor.y * natural.height), size);
  }
  const rect = anchorRect(anchor, natural);
  return strings.region(`x ${rect.x}–${rect.x + rect.width}, y ${rect.y}–${rect.y + rect.height}`, size);
}

export function terminalSafe(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function inline(text: string): string {
  return text.replace(/[\r\n\u0085\u2028\u2029]+/g, " ").replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

export function handoffText(input: HandoffTextInput): string {
  const strings = STRINGS[input.locale];
  const lines: string[] = [strings.header(input.number, input.remarks.length), "", strings.folder, code(input.folder)];
  if (input.editable.length > 0) {
    lines.push("", strings.editable, ...input.editable.map((path) => `- ${code(path)}`), strings.onlyEditable);
  } else {
    lines.push("", strings.noEditable);
  }
  for (const remark of input.remarks) {
    const target = remark.target;
    lines.push("", `#${remark.number} · ${inline(target.name)}, ${strings.version} ${target.versionNumber} · ${describeAnchor(target.anchor, target.natural, input.locale)}`);
    if (target.location) lines.push(`${strings.source} ${code(target.location)}`);
    lines.push(`${strings.snapshot} ${code(target.file)}`);
    if (target.marked) lines.push(`${strings.marked} ${code(target.marked)}`);
    if (target.crop) lines.push(`${strings.crop} ${code(target.crop)}`);
    if (remark.reference) {
      const reference = remark.reference;
      const details = [
        `${inline(reference.name)}, ${strings.version} ${reference.versionNumber}`,
        describeAnchor(reference.anchor, reference.natural, input.locale),
        reference.crop ? `${strings.crop} ${code(reference.crop)}` : `${strings.snapshot} ${code(reference.file)}`
      ];
      lines.push(`${strings.reference} ${details.join(" · ")}`);
    }
    lines.push(`${strings.requirement} ${remark.text}`);
  }
  if (input.note.trim()) lines.push("", `${strings.note} ${input.note.trim()}`);
  lines.push("", strings.finish(input.remarks.map((remark) => `#${remark.number}`).join(", ")));
  if (input.resultsFolder) {
    lines.push(`${strings.results} ${code(input.resultsFolder)} ${strings.resultsTail}`);
    if (input.reportFile) lines.push(`${strings.report} ${code(input.reportFile)} ${strings.reportShape}`);
  }
  return terminalSafe(lines.join("\n") + imageBlock(input));
}

export function handoffPointerText(input: HandoffTextInput, handoffFile: string): string {
  const strings = STRINGS[input.locale];
  return terminalSafe(`${strings.pointer(input.number)} ${code(handoffFile)} ${strings.pointerTail}` + imageBlock(input));
}

function imageBlock(input: HandoffTextInput): string {
  if (input.images.length === 0) return "";
  const strings = STRINGS[input.locale];
  const names = `${strings.attached} ${input.images.map((image, index) => `${index + 1}) ${code(image.name)}`).join(" ")}`;
  if (input.imageMode === "claude") return `\n\n${names}\n${input.images.map((image) => image.path).join("\n")}`;
  if (input.imageMode === "codex") return `\n\n${names}`;
  return `\n\n${strings.open}\n${input.images.map((image) => `- ${code(image.path)}`).join("\n")}`;
}

function quoted(value: string, locale: LocaleId): string {
  return locale === "ru" ? `«${inline(value)}»` : `“${inline(value)}”`;
}

function share(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function code(value: string): string {
  const text = inline(value);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}
