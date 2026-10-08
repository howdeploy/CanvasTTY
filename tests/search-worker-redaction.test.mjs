import test from 'node:test';
import assert from 'node:assert/strict';
import {SecretRedactionRegistry,redactionRegistryFromWorkerSnapshot} from '../src/main/services/safety/SecretRedaction.ts';

test('trusted worker mirror retains all owners and masks wrapped secrets before clipping results',()=>{
 const registry=new SecretRedactionRegistry();
 const values=Array.from({length:80},(_,i)=>`opaque-test-secret-${String(i).padStart(3,'0')}`);
 registry.add('one',values.slice(0,40));registry.add('two',values.slice(40));
 const snapshot=registry.snapshotForWorker(),mirror=redactionRegistryFromWorkerSnapshot(snapshot.values);
 const wrapped=values.at(-1).slice(0,10)+'\n│ '+values.at(-1).slice(10);
 assert.equal(mirror.redact(wrapped),registry.redact(wrapped));assert.ok(!mirror.redact(wrapped).includes('opaque-test'));
 assert.equal(mirror.redact(values.join('\n')),registry.redact(values.join('\n')));
 const version=snapshot.revision;registry.add('one',[values[0]]);assert.equal(registry.snapshotForWorker().revision,version);
 registry.clear('two');assert.ok(registry.snapshotForWorker().revision>version);assert.equal(registry.snapshotForWorker().values.length,40);
 snapshot.values.length=0;assert.equal(registry.snapshotForWorker().values.length,40);
});
