export interface ShutdownStep {
  name: string;
  run(): void | Promise<unknown>;
}

/** Cleanup remains ordered, but one failed save must not skip independent services. */
export async function runShutdownSteps(steps: readonly ShutdownStep[],
  warn: (message: string, error: unknown) => void = console.warn): Promise<void> {
  for (const step of steps) {
    try { await step.run(); }
    catch (error) { warn(`CanvasTTY shutdown: ${step.name} failed.`, error); }
  }
}
