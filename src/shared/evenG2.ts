import type { CompanionGrant, CompanionSession } from "./companion.ts";

export interface EvenG2Config {
  enabled: boolean;
  workspace: string;
  interfaceName: string;
  publicOrigin: string;
  sessionIds: string[];
  allowInput: boolean;
  allowCreate: boolean;
  allowClose: boolean;
  allowBrowser: boolean;
  speechExecutable: string;
  speechModel: string;
}
export interface EvenG2Address {
  id: string;
  name: string;
  address: string;
}
export interface EvenG2Telemetry {
  clientVersion: string;
  display: "confirmed" | "unknown";
  microphone: "never" | "on" | "off" | "unknown";
  audioBytes: number;
  error: string;
  diagnostics?: string[];
}
export interface EvenG2Peer {
  id: string;
  name: string;
  grant: CompanionGrant;
  lastSeen: number;
  telemetry: EvenG2Telemetry | null;
}
export interface EvenG2State {
  config: EvenG2Config;
  availableSessions: CompanionSession[];
  peers: EvenG2Peer[];
  pairing: {
    code: string;
    expiresAt: number;
    pending: { id: string; name: string } | null;
  } | null;
  transport: {
    kind: "lan" | "https";
    addresses: EvenG2Address[];
    origin: string;
    origins?: string[];
    ready: boolean;
  };
  listening: boolean;
  port: number;
  error: string;
  speechSetup?: SpeechSetupState;
  speech?: { available: boolean; model: string };
}
export type EvenG2Command =
  | { type: "configure"; config: EvenG2Config }
  | { type: "refresh" }
  | { type: "begin-pairing" }
  | { type: "cancel-pairing" }
  | { type: "approve"; id: string }
  | { type: "reject" }
  | { type: "revoke"; id: string }
  | { type: "prepare-speech" }
  | { type: "cancel-speech-setup" };
export interface EvenG2Api {
  state(): Promise<EvenG2State>;
  command(command: EvenG2Command): Promise<EvenG2State>;
  onOpenBrowser(listener: (requestId: string) => void): () => void;
  completeOpenBrowser(requestId: string, ok: boolean): void;
}

export interface SpeechSetupState {
  supported: boolean;
  phase: "missing" | "downloading" | "verifying" | "ready" | "error";
  received: number;
  total: number;
  model: string;
  error: string;
}
