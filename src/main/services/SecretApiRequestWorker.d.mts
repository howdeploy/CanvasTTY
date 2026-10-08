export interface SecretApiWorkerInput {
  secretId: string;
  profile: { protocol: string; baseUrl: string };
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

export interface SecretApiWorkerResult {
  status: number;
  body: string;
  truncated: boolean;
}

export function normalizePublicHttpsBaseUrl(value: unknown): string;
export function buildProviderApiUrl(baseUrl: string, path: string): string;
export function performSecretApiRequest(
  input: SecretApiWorkerInput,
  secret: string,
  fetchImpl?: typeof fetch,
  signal?: AbortSignal
): Promise<SecretApiWorkerResult>;
export const SECRET_API_REQUEST_WORKER_SOURCE: string;
