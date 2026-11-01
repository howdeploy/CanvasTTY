import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { BrowserAutomationService } from '../../src/main/services/browser/BrowserAutomationService.ts';

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 650,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = window.webContents;
  const automation = new BrowserAutomationService();
  try {
    await wc.loadURL(process.env.CANVASTTY_EDITOR_FIXTURE_URL);
    await automation.register('fixture', wc, 1);
    const read = source => wc.executeJavaScript(source);
    const wait = async source => {
      for (let n = 0; n < 100; n++) {
        if (await read(source)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw Error('Fixture state timed out: ' + source + '; editor preview=' + JSON.stringify(await read('window.editor.state.doc.toString().slice(0,200)')));
    };
    const ref = async name => {
      const observation = await automation.observe('fixture', 1, undefined, 200);
      const element = observation.elements.find(e => e.name === name);
      assert.ok(element, 'Missing ' + name);
      return element.ref;
    };
    const replace = async (name, text) => automation.type('fixture', 1, await ref(name), text, undefined, 'replace');
    const text = "SELECT 'Миша';\nSELECT 2;";
    const primary = process.platform === 'darwin' ? 'Meta' : 'Ctrl';
    for (const [name, selector, property] of [
      ['Plain', 'input', 'value'], ['Multiline', 'textarea', 'value'],
      ['Rich', '[contenteditable]', 'innerText']
    ]) {
      const value = name === 'Plain' ? 'replacement' : text;
      await replace(name, value);
      assert.equal(await read('document.querySelector(' + JSON.stringify(selector) + ').' + property), value);
      await replace(name, '');
      const emptyProperty = name === 'Rich' ? 'textContent' : property;
      assert.equal(await read('document.querySelector(' + JSON.stringify(selector) + ').' + emptyProperty), '');
    }
    await automation.type('fixture', 1, await ref('Plain'), 'legacy');
    assert.equal(await read('document.querySelector("input").value'), 'legacy');
    await automation.press('fixture', 1, await ref('Plain'), 'End');
    await automation.type('fixture', 1, await ref('Plain'), ' appended', undefined, 'insert');
    assert.equal(await read('document.querySelector("input").value'), 'legacy appended');
    await assert.rejects(replace('Readonly', 'bad'), e => e.code === 'INVALID_INPUT');
    await assert.rejects(replace('Not editable', 'bad'), e => e.code === 'INVALID_INPUT');
    assert.equal(await read('document.querySelector("[readonly]").value'), 'protected');
    console.log('Checking CodeMirror replacement');
    await replace('SQL editor', text);
    await wait('window.editor.state.doc.toString()===' + JSON.stringify(text));
    await automation.press('fixture', 1, await ref('SQL editor'), 'Ctrl+Enter');
    await wait('document.querySelector("#submitted").textContent===' + JSON.stringify(text));
    await automation.press('fixture', 1, await ref('SQL editor'), primary === 'Ctrl' ? 'Control+A' : 'Meta+A');
    await automation.type('fixture', 1, await ref('SQL editor'), 'SELECT 3;', undefined, 'insert');
    await wait('window.editor.state.doc.toString()==="SELECT 3;"');
    console.log('Checking CodeMirror undo after chord replacement');
    await automation.press('fixture', 1, await ref('SQL editor'), primary + '+Z');
    await wait('window.editor.state.doc.toString()===' + JSON.stringify(text));
    // A virtualized document has unrendered lines: replacement must cover its model, not just visible text.
    await read('window.editor.dispatch({changes:{from:0,to:window.editor.state.doc.length,insert:Array.from({length:2000},(_,i)=>"SELECT "+i+";").join("\\n")}})');
    assert.equal(await read('window.editor.state.doc.lines'), 2000);
    await replace('SQL editor', 'SELECT final;');
    await wait('window.editor.state.doc.toString()==="SELECT final;"');
    await replace('SQL editor', '');
    await wait('window.editor.state.doc.length===0');
    await automation.press('fixture', 1, await ref('SQL editor'), primary + '+Z');
    await wait('window.editor.state.doc.toString()==="SELECT final;"');
    await assert.rejects(automation.press('fixture', 1, await ref('SQL editor'), 'Ctrl+'), e => e.code === 'INVALID_INPUT');
    console.log('CANVASTTY_EDITOR_SMOKE_OK: native fields, contenteditable, CodeMirror state/undo, chords and protected targets');
  } finally {
    automation.unregister('fixture');
    window.destroy();
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
