import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

window.editor = new EditorView({
  doc: 'SELECT old;',
  parent: document.querySelector('#editor'),
  extensions: [
    // Keep separate automated editing actions separate in undo history.
    history({ newGroupDelay: 0 }),
    EditorView.contentAttributes.of({ 'aria-label': 'SQL editor' }),
    keymap.of([{ key: 'Ctrl-Enter', run(view) {
      document.querySelector('#submitted').textContent = view.state.doc.toString();
      return true;
    } }]),
    keymap.of([...defaultKeymap, ...historyKeymap])
  ]
});
