/** Deduplicate Windows case aliases before inspecting and spawning an environment.
 * Later launch layers win; the child receives the same unambiguous map.
 */
export function normalizeProcessEnvironment<T extends string | undefined>(
  environment: Readonly<Record<string, T>>, platform: NodeJS.Platform = process.platform
): Record<string, T> {
  return Object.fromEntries(Object.entries(environment).map(([key, value]) =>
    [platform === "win32" ? key.toUpperCase() : key, value]));
}
