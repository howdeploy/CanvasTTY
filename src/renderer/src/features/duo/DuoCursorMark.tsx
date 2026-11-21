import type { LocaleId } from "../../../../shared/contracts";
import { normalizeDuoCursorDesign, normalizeDuoCursorNickname, type DuoCursorDesign } from "../../../../shared/canvasDuo";

const styles: Record<DuoCursorDesign, readonly [russian: string, english: string]> = {
  blob: ["Блоб", "Blob"],
  circle: ["Круг", "Circle"],
  triangle: ["Треугольник", "Triangle"],
  square: ["Квадрат", "Square"],
  diamond: ["Ромб", "Diamond"],
  capsule: ["Капсула", "Capsule"],
  cloud: ["Облако", "Cloud"],
  star: ["Звезда", "Star"],
  hexagon: ["Шестиугольник", "Hexagon"],
  heart: ["Сердце", "Heart"]
};

export function duoCursorName(design: DuoCursorDesign, locale: LocaleId): string {
  return styles[design][locale === "ru" ? 0 : 1];
}

export function defaultDuoCursorDesign(author?: string): DuoCursorDesign {
  return author === "guest" ? "circle" : "blob";
}

export function DuoCursorMark({ design, author, nickname, locale }: {
  design?: DuoCursorDesign;
  author?: string;
  nickname?: string;
  locale?: LocaleId;
}): React.JSX.Element {
  const id = normalizeDuoCursorDesign(design) ?? defaultDuoCursorDesign(author);
  const label = author === "host" ? (locale === "ru" ? "Хост" : "Host") : (locale === "ru" ? "Гость" : "Guest");
  return <span className="duo-cursor-mark" data-design={id} aria-hidden="true">
    <span className="duo-cursor-mark__arrow" />
    <span className="duo-cursor-mark__mascot"><span className="duo-cursor-mark__eyes" /></span>
    {author && <span className="duo-cursor-mark__label" dir="auto">{normalizeDuoCursorNickname(nickname) ?? label}</span>}
  </span>;
}
