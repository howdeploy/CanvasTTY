/** In-memory navigation only; never a persisted setting or arbitrary route. */
export type SettingsLocation =
  | { section: 'context' | 'decisions' }
  | { section: "connections"; view: "accounts" | "api" | "data"; recordId?: string }
  | { section: "execution"; view: "hosts" | "workspaces" | "containers" | "limits"; recordId?: string };
