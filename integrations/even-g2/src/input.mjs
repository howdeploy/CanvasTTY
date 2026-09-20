// Protobuf omits the default enum value (CLICK=0). The typed SDK event can
// therefore have no eventType, including on sysEvent. Never infer input from
// untyped messages, motion payloads, exit reasons or another container.
export function inputEvent(event, sdk) {
  const parts = ["textEvent", "listEvent", "sysEvent"].flatMap((kind) => {
    const part = event[kind];
    if (
      !part ||
      typeof part !== "object" ||
      part.imuData != null ||
      (part.systemExitReasonCode != null && part.eventType == null)
    )
      return [];
    if (part.containerID != null && part.containerID !== 1) return [];
    return [{ kind, part }];
  });
  for (const { kind, part } of parts) {
    if (part.eventType == null) continue;
    const type = sdk.OsEventTypeList.fromJson(part.eventType);
    if (type !== undefined)
      return { kind, type, source: part.eventSource, defaulted: false };
  }
  const omitted = parts.find(({ part }) => part.eventType == null);
  return omitted
    ? {
        kind: omitted.kind,
        type: sdk.OsEventTypeList.CLICK_EVENT,
        source: omitted.part.eventSource,
        defaulted: true,
      }
    : null;
}
