/** Exact local origins used by both Bonjour and the Even App manifest. */
// Keep complete URLs literal: Even Hub checks emitted bundle URLs against the
// manifest and cannot resolve a template such as http://${host}:3481.
export const LOCAL_DISCOVERY_ORIGINS = [
  "http://canvastty.local:3481",
  "http://canvastty-2.local:3481",
  "http://canvastty-3.local:3481",
  "http://canvastty-4.local:3481",
  "http://canvastty-5.local:3481",
  "http://canvastty-6.local:3481",
  "http://canvastty-7.local:3481",
  "http://canvastty-8.local:3481",
];
export const LOCAL_DISCOVERY_HOSTS = LOCAL_DISCOVERY_ORIGINS.map(
  origin => new URL(origin).hostname,
);
export const PAIRING_IDENTITY = "CanvasTTY/local-pairing/2";
export function sixDigitCode(value: unknown): string {
  const code = String(value ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw new Error("Введите 6 цифр из CanvasTTY на Mac.");
  return code;
}
