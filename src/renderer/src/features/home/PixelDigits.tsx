// Original 5 × 7 digit glyphs; no downloaded fonts or external requests.
const glyphs: Record<string, string[]> = {
  "0": ["01110","11011","11011","11011","11011","11011","01110"],
  "1": ["00110","01110","00110","00110","00110","00110","01111"],
  "2": ["01110","11011","00011","00110","01100","11000","11111"],
  "3": ["11110","00011","00011","01110","00011","00011","11110"],
  "4": ["00011","00111","01111","11011","11111","00011","00011"],
  "5": ["11111","11000","11000","11110","00011","00011","11110"],
  "6": ["01110","11000","11000","11110","11011","11011","01110"],
  "7": ["11111","00011","00110","00110","01100","01100","01100"],
  "8": ["01110","11011","11011","01110","11011","11011","01110"],
  "9": ["01110","11011","11011","01111","00011","00011","01110"],
  ":": ["0","1","1","0","1","1","0"]
};
export function PixelDigits({ value }: { value: string }): React.JSX.Element {
  let x = 0;
  const pixels: React.JSX.Element[] = [];
  for (const [index, character] of [...value].entries()) {
    const glyph = glyphs[character] ?? ["0","0","0","0","0","0","0"];
    glyph.forEach((row, y) => [...row].forEach((pixel, dx) => { if (pixel === "1") pixels.push(<rect key={`${index}-${y}-${dx}`} x={x + dx} y={y} width="1" height="1" />); }));
    x += glyph[0].length + 1;
  }
  return <svg className="clock-pixel-digits" viewBox={`0 0 ${x - 1} 7`} role="img" aria-label={value} shapeRendering="crispEdges" fill="currentColor">{pixels}</svg>;
}
