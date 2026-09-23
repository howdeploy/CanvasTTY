import { DECISION_BYTES, parseDecisionJson, validateEvaluationRequest, validateEvaluationResult, type DecisionBackend, type EvaluationRequest, type EvaluationResult } from './DecisionBackend.ts';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export class JevBackend implements DecisionBackend {
 private readonly transport: typeof fetch;
 constructor(transport: typeof fetch = fetch) { this.transport = transport; }
 async evaluate(request: EvaluationRequest, credential: string, signal: AbortSignal): Promise<EvaluationResult> {
  signal.throwIfAborted(); const body = validateEvaluationRequest(request);
  if (!credential.trim() || /[\r\n]/u.test(credential)) throw new Error('Invalid evaluator credential.');
  const controller = new AbortController(), abort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Decision deadline exceeded.')), 3000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelled = new Promise<never>((_, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('Decision cancelled or deadline exceeded.')), { once: true }); });
  try {
   const work = async (): Promise<EvaluationResult> => {
    const response = await this.transport(JEV_ENDPOINT, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Decision endpoint rejected the request (${response.status}).`);
    const length = response.headers.get('content-length'); if (length && (!/^\d+$/u.test(length) || Number(length) > DECISION_BYTES)) throw new Error('Decision response exceeds byte limit.');
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) { controller.signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > DECISION_BYTES) throw new Error('Decision response exceeds byte limit.'); chunks.push(chunk.value); }
    controller.signal.throwIfAborted(); const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const result = validateEvaluationResult(parseDecisionJson(text), request);
    // jev-latest may answer with its own name or a resolved version; a pinned version must match.
    if (!/^jev-[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/u.test(result.model) || request.model !== 'jev-latest' && result.model !== request.model && !result.model.startsWith(`${request.model}.`)) throw new Error('Evaluator model version mismatch.');
    return result;
   };
   return await Promise.race([work(), cancelled]);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); void reader?.cancel().catch(() => {}); }
 }
}
