import { delegationLaunchFixture } from './delegation-launch-fixture.mjs';
import { SettingsStore } from '../../src/main/services/SettingsStore.ts';
import { DecisionCoordinator } from '../../src/main/services/decision/DecisionCoordinator.ts';
import { DecisionSecrets } from '../../src/main/services/decision/DecisionSecrets.ts';
import { DEFAULT_DECISION_SETTINGS } from '../../src/shared/decisions.ts';
export async function decisionRoutingFixture(hooks = {}) {
 const f = await delegationLaunchFixture(hooks);
 const store = new SettingsStore(f.root, 'ru');
 Object.assign(f.settings, { ...store.get(), ...f.settings, decisions: { ...DEFAULT_DECISION_SETTINGS, mode: 'rules', routes: [{ id: 'claude-local', provider: 'claude', hostId: 'local', transport: 'pty' }, { id: 'codex-local', provider: 'codex', hostId: 'local', transport: 'pty' }], ...hooks.decisions } });
 let evaluatorCalls = 0, decisionSecretReads = 0;
 const payloads = [], secretOperations = { status: 0, get: 0, set: 0, remove: 0 };
 const secretStore = new DecisionSecrets(f.root, { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: buffer => buffer.toString() }, () => coordinator.invalidate());
 const secrets = { get generation() { return secretStore.generation; },
  get() { secretOperations.get++; return secretStore.get(); }, status() { secretOperations.status++; return secretStore.status(); },
  set(value) { secretOperations.set++; return secretStore.set(value); }, remove() { secretOperations.remove++; return secretStore.remove(); } };
 const coordinator = new DecisionCoordinator({ settings: () => f.settings, terminals: f.manager, control: f.control, secrets: { get: () => { decisionSecretReads++; return secrets.get(); }, get generation() { return secrets.generation; } }, now: hooks.now, localCliAvailable: hooks.localCliAvailable, limits: hooks.limits,
  backend: { async evaluate(request, key, signal) { evaluatorCalls++; payloads.push(structuredClone(request)); if (hooks.evaluate) return hooks.evaluate(request, key, signal); const ids = Object.keys(request.questions.route.criteria); return { model: 'jev-1.13.0', answers: { route: { type: 'choice', choice: ids[0], confidence: 0.9, probabilities: Object.fromEntries(ids.map((id, index) => [id, index ? 0 : 1])) } }, usage: { input_tokens: 12, output_tokens: 6 } }; } } });
 f.scope.configureDecisions(coordinator); f.manager.configureDecisionInvalidation(id => coordinator.invalidate(id));
 return { ...f, store, coordinator, secrets, payloads, secretOperations, evaluatorCalls: () => evaluatorCalls, decisionSecretReads: () => decisionSecretReads,
  async saveSettings(patch) { const next = await store.update({ ...f.settings, ...patch }); Object.assign(f.settings, next); coordinator.invalidate(); return next; },
  async cleanup() { coordinator.dispose(); await f.cleanup(); } };
}
