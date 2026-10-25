interface ToastProps {
  message: string | null;
  /** One button next to the text (for example "Open settings"); the toast takes clicks only while it has one. */
  action?: { label: string; run(): void } | null;
}

export function Toast({ message, action }: ToastProps): React.JSX.Element {
  return (
    <div className={`toast ${message ? "toast--visible" : ""}${message && action ? " toast--action" : ""}`} role={message && action ? "alert" : undefined}>
      {message}
      {message && action && <button className="toast__action" type="button" onClick={action.run}>{action.label}</button>}
    </div>
  );
}
