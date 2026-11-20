export interface DuoDiagnosticEvent {
  at: string;
  attempt: string;
  role: 'host' | 'guest';
  transport: 'p2p' | 'lan';
  stage: string;
  elapsedMs: number;
  code?: string;
}
export interface DuoDiagnosticReport {
  formatVersion: 1;
  context?: { appVersion:string; platform:string; arch:string };
  events: DuoDiagnosticEvent[];
}
