import { routeEconomics, type DecisionInput, type DecisionRoute, type DecisionSettings } from '../../../shared/decisions.ts';
import { DATA_CLASS_RANK, REASONING_EFFORTS, type DataClass } from '../../../shared/contracts.ts';

/** Only '*' and '**' are patterns; other punctuation is literal, never a user regular expression. */
function matches(pattern: string, path: string): boolean {
  const text = path.replaceAll('\\', '/');
  let previous = new Uint8Array(text.length + 1);
  previous[0] = 1;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index], star = char === '*', recursive = star && pattern[index + 1] === '*';
    if (recursive) index++;
    const next = new Uint8Array(text.length + 1);
    if (star) next[0] = previous[0]!;
    for (let offset = 1; offset <= text.length; offset++) next[offset] = star
      ? previous[offset]! || ((recursive || text[offset - 1] !== '/') ? next[offset - 1]! : 0)
      : char === text[offset - 1] ? previous[offset - 1]! : 0;
    previous = next;
  }
  return previous[text.length] === 1;
}

const MEDIUM_EFFORT = REASONING_EFFORTS.indexOf('medium');

/** Deterministic effort/cost trade-off used when no rule applies and the difficulty is known.
 * Unknown estimates sort as average; ties keep the configured order. */
function economicOrder<T extends DecisionRoute>(routes: readonly T[], difficulty: NonNullable<DecisionInput['difficulty']>): T[] {
  const scored = routes.map((route, index) => {
    const { cost, quality } = routeEconomics(route);
    const effort = route.effort ? REASONING_EFFORTS.indexOf(route.effort) : null;
    const key = difficulty === 'simple' ? [cost ?? 3, -(quality ?? 3)]
      : difficulty === 'hard' ? [-(quality ?? 3), cost ?? 3]
        : [effort === null ? 0.5 : Math.abs(effort - MEDIUM_EFFORT), cost ?? 3];
    return { route, index, key };
  });
  scored.sort((a, b) => a.key[0]! - b.key[0]! || a.key[1]! - b.key[1]! || a.index - b.index);
  return scored.map(item => item.route);
}

export function rankRoutes<T extends DecisionRoute>(settings: DecisionSettings, input: Pick<DecisionInput, 'category' | 'cwd' | 'initialPrompt' | 'difficulty'> & { dataClass: DataClass }, routes: readonly T[]): { routes: T[]; ruleId?: string } {
  const rule = settings.rules.find(rule => (!rule.category || rule.category === (input.category ?? 'general'))
    && (!rule.taskContains || (input.initialPrompt ?? '').toLocaleLowerCase().includes(rule.taskContains.toLocaleLowerCase()))
    && (!rule.pathPattern || matches(rule.pathPattern, input.cwd))
    && (!rule.maxDataClass || DATA_CLASS_RANK[input.dataClass] <= DATA_CLASS_RANK[rule.maxDataClass])
    && rule.prefer.some(id => routes.some(route => route.id === id)));
  if (!rule) return { routes: input.difficulty ? economicOrder(routes, input.difficulty) : [...routes] };
  const rank = (id: string): number => { const index = rule.prefer.indexOf(id); return index < 0 ? 16 : index; };
  return { routes: [...routes].sort((a, b) => rank(a.id) - rank(b.id)), ruleId: rule.id };
}
