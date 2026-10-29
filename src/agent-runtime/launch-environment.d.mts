export function connectedLaunchEnvironment<T extends Readonly<Record<string, string | undefined>>>(
  environment: T,
  platform?: NodeJS.Platform,
  inspect?: (directory: string) => unknown
): T;
