# Finding settings and provider limits

Settings has a search field above its section sidebar. Search accepts Russian and
English labels and descriptions regardless of the interface language. Words are
matched together, without case sensitivity. Choose a result with the mouse or
Tab/Enter to open its section and focus the setting. Clear the field to return to
the normal sidebar. Search never changes saved preferences.

When adding a SettingGroup, include its translation keys in
`features/settings/settingsSearch.ts` so its destination remains discoverable.

## Provider limits

Provider visibility is controlled by **Settings → Agents → Limit display**.
The empty HOME limits message and unavailable provider rows link directly to that
group. The destination opens, scrolls into view, and receives keyboard focus.
Loading states remain passive. The existing switches and saved provider selection
are preserved; a missing CLI or unsupported quota API still shows its real reason.
The limits widget itself can be shown or hidden in Appearance → HOME layout.
