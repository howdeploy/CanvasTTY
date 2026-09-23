import { exactRecord } from '../../../shared/decisions.ts';

export type DecisionQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, unknown> }
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } };
export interface EvaluationRequest { model: string; state: unknown; questions: Record<string, DecisionQuestion> }
export type DecisionAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number };
export interface EvaluationResult { model: string; answers: Record<string, DecisionAnswer>; usage: { input_tokens: number; output_tokens: number } | null }
export interface DecisionBackend { evaluate(request: EvaluationRequest, credential: string, signal: AbortSignal): Promise<EvaluationResult> }

export const DECISION_BYTES = 65536;
export const MAX_DECISION_CHOICES = 64;

/** Bounded JSON parser rejects duplicate keys before JSON.parse can silently replace one. */
export function parseDecisionJson(text: string): unknown {
  if (Buffer.byteLength(text) > DECISION_BYTES) throw new Error('Decision response exceeds byte limit.');
  let i = 0, nodes = 0;
  const ws = (): void => { while (/\s/u.test(text[i] ?? '') && i < text.length) i++; };
  const string = (): string => {
    const start = i++;
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') i++;
      else if (c === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    throw new Error('Invalid JSON string.');
  };
  const value = (depth: number): void => {
    if (depth > 16 || ++nodes > 4096) throw new Error('Decision JSON structure limit exceeded.');
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      const keys = new Set<string>();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Error('Invalid JSON key.');
        const key = string();
        if (keys.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Duplicate or forbidden JSON key.');
        keys.add(key); ws();
        if (text[i++] !== ':') throw new Error('Invalid JSON object.');
        value(depth + 1); ws();
        if (text[i] === '}') { i++; return; }
        if (text[i++] !== ',') throw new Error('Invalid JSON object.');
      }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        value(depth + 1); ws();
        if (text[i] === ']') { i++; return; }
        if (text[i++] !== ',') throw new Error('Invalid JSON array.');
      }
    }
    if (c === '"') { string(); return; }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(i));
    if (!match) throw new Error('Invalid JSON value.');
    i += match[0].length;
    if (!['true', 'false', 'null'].includes(match[0]) && !Number.isFinite(Number(match[0]))) throw new Error('Nonfinite decision value.');
  };
  value(0); ws();
  if (i !== text.length) throw new Error('Trailing decision JSON.');
  return JSON.parse(text);
}

export function validateEvaluationRequest(request: EvaluationRequest): string {
  exactRecord(request, ['model', 'state', 'questions'], ['model', 'state', 'questions']);
  if (typeof request.model !== 'string' || !request.model || request.model.length > 100) throw new Error('Invalid evaluator model.');
  exactRecord(request.questions, Object.keys(request.questions));
  const questions = Object.entries(request.questions);
  if (!questions.length || questions.length > 32) throw new Error('Decision question limit exceeded.');
  for (const [id, question] of questions) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new Error('Invalid question ID.');
    exactRecord(question, ['type', 'instructions', 'criteria'], ['type', 'instructions']);
    if (typeof question.instructions !== 'string' || !question.instructions || question.instructions.length > 4096) throw new Error('Invalid decision instructions.');
    if (question.type === 'choice') {
      exactRecord(question.criteria, Object.keys(question.criteria));
      const ids = Object.keys(question.criteria);
      if (ids.length < 2 || ids.length > MAX_DECISION_CHOICES || ids.some(id => !/^[A-Za-z0-9_-]{1,64}$/u.test(id))) throw new Error('Invalid decision choices.');
    } else if (question.type === 'noul') {
      if (question.criteria !== undefined) {
        exactRecord(question.criteria, ['true', 'false']);
        if (Object.values(question.criteria).some(v => typeof v !== 'string' || v.length > 4096)) throw new Error('Invalid Noul criteria.');
      }
    } else throw new Error('Unsupported decision question type.');
  }
  const serialized = JSON.stringify(request, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value) || value === undefined || typeof value === 'function' || typeof value === 'symbol') throw new Error('Non-JSON decision input.');
    return value;
  });
  parseDecisionJson(serialized);
  return serialized;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid decision probability.');
  return value;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Token counts in either the documented or the chat-completions naming; absent counts stay unknown. */
function measuredUsage(value: unknown): EvaluationResult['usage'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const input = tokenCount(usage.input_tokens) ?? tokenCount(usage.prompt_tokens);
  const output = tokenCount(usage.output_tokens) ?? tokenCount(usage.completion_tokens);
  return input === null || output === null ? null : { input_tokens: input, output_tokens: output };
}

/** Required answers are strict (known choice, valid distribution); unrecognised extra fields are ignored,
 * so a documented response with additional metadata is not discarded. */
export function validateEvaluationResult(value: unknown, request: EvaluationRequest, options: { probabilityTolerance?: number } = {}): EvaluationResult {
  const result = record(value, 'Invalid evaluator response.');
  if (typeof result.model !== 'string' || !result.model || result.model.length > 100 || /[\x00-\x20\x7f]/u.test(result.model)) throw new Error('Missing actual evaluator model.');
  const tolerance = options.probabilityTolerance ?? 0.01;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.05) throw new Error('Invalid distribution tolerance.');
  const answersIn = record(result.answers, 'Missing evaluator answers.');
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = record(answersIn[id], 'Missing decision answer.');
    if (question.type === 'noul') {
      if (answer.type !== 'noul') throw new Error('Decision answer type mismatch.');
      answers[id] = { type: 'noul', noul: probability(answer.noul) };
      continue;
    }
    const ids = Object.keys(question.criteria);
    if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !ids.includes(answer.choice)) throw new Error('Unknown decision choice.');
    const given = record(answer.probabilities, 'Missing decision probabilities.');
    if (Object.keys(given).some(key => !ids.includes(key)) || !Object.hasOwn(given, answer.choice)) throw new Error('Invalid decision probability distribution.');
    const probabilities: Record<string, number> = {};
    for (const [key, item] of Object.entries(given)) probabilities[key] = probability(item);
    const values = Object.values(probabilities), total = values.reduce((a, b) => a + b, 0);
    const complete = ids.every(key => Object.hasOwn(probabilities, key));
    if ((complete ? Math.abs(total - 1) : total - 1) > tolerance || probabilities[answer.choice]! + 1e-9 < Math.max(...values)) throw new Error('Invalid decision probability distribution.');
    const confidence = answer.confidence === undefined ? probabilities[answer.choice]! : probability(answer.confidence);
    answers[id] = { type: 'choice', choice: answer.choice, probabilities, confidence };
  }
  return { model: result.model, answers, usage: measuredUsage(result.usage) };
}
