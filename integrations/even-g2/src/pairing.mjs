export async function validatePairing(code, { probe, persist }) {
  const normalized = String(code || "").trim();
  if (!/^\d{6}$/.test(normalized))
    throw new Error(
      "Введите шестизначный код из CanvasTTY. Текущее подключение сохранено.",
    );
  const result = await probe(normalized);
  if (
    !result ||
    !Array.isArray(result.home?.sessions) ||
    !/^[a-f0-9]{64}$/.test(result.token)
  )
    throw new Error("Подключение не подтверждено.");
  if (persist && (await persist(result.token)) !== true)
    throw new Error(
      "Не удалось сохранить подключение. Текущее подключение сохранено.",
    );
  return result;
}
