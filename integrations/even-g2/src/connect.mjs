export async function pairComputer(
  base,
  code,
  { name = "Even App", onPending = () => {}, signal, fetcher = fetch } = {},
) {
  const send = (url, options) =>
    fetcher(url, {
      ...options,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000),
    });
  const start = await send(base + "/g2/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name }),
    signal,
    credentials: "omit",
    redirect: "error",
  });
  if (!start.ok)
    throw new Error(
      "Код недействителен или истёк. Создайте новый код на компьютере.",
    );
  const pending = await start.json();
  if (!/^[a-f0-9]{64}$/.test(pending.token))
    throw new Error("Некорректный ответ подключения.");
  onPending();
  const expires = Date.now() + 120000;
  while (Date.now() < expires) {
    if (signal?.aborted) throw new Error("Подключение отменено.");
    const response = await send(base + "/g2/api/pair-status", {
      headers: { Authorization: "Bearer " + pending.token },
      signal,
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) throw new Error("Не удалось проверить подтверждение.");
    const result = await response.json();
    if (result.state === "approved") {
      const home = await send(base + "/g2/api/home", {
        headers: { Authorization: "Bearer " + pending.token },
        signal,
        credentials: "omit",
        redirect: "error",
      });
      if (!home.ok) throw new Error("Компьютер недоступен.");
      return { token: pending.token, home: await home.json() };
    }
    if (result.state !== "pending")
      throw new Error("Подключение отклонено или код истёк.");
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error("Время подтверждения истекло.");
}
