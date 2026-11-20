import type { CSSProperties } from "react";
import type { LocaleId } from "../../../../shared/contracts";
import { normalizeDuoCursorDesign, normalizeDuoCursorNickname, type DuoCursorDesign } from "../../../../shared/canvasDuo";

const styles: Record<DuoCursorDesign, readonly [color: string, russian: string, english: string]> = {
  blob: ["#c4b5fd", "Блоб", "Blob"],
  circle: ["#b8d888", "Круг", "Circle"],
  triangle: ["#f7bc83", "Треугольник", "Triangle"],
  square: ["#97c5f9", "Квадрат", "Square"],
  diamond: ["#f4a3c9", "Ромб", "Diamond"],
  capsule: ["#9ddfca", "Капсула", "Capsule"],
  cloud: ["#c9d6e9", "Облако", "Cloud"],
  star: ["#f5d36d", "Звезда", "Star"],
  hexagon: ["#b1a3ea", "Шестиугольник", "Hexagon"],
  heart: ["#f49297", "Сердце", "Heart"]
};

export function duoCursorName(design: DuoCursorDesign, locale: LocaleId): string {
  return styles[design][locale === "ru" ? 1 : 2];
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
  return <span className="duo-cursor-mark" data-design={id} style={{ "--duo-cursor-color": styles[id][0] } as CSSProperties} aria-hidden="true">
    <span className="duo-cursor-mark__arrow" />
    <span className="duo-cursor-mark__mascot"><span className="duo-cursor-mark__eyes" /></span>
    {author && <span className="duo-cursor-mark__label" dir="auto">{normalizeDuoCursorNickname(nickname) ?? label}</span>}
  </span>;
}
