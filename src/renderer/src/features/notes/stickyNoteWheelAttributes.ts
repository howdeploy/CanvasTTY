export function stickyNoteWheelAttributes(noteId: string) {
  return {
    card: { "data-canvas-widget-id": `note:${noteId}` },
    editor: { "data-canvas-wheel-priority": "local" }
  } as const;
}
