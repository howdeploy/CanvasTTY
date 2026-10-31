# Finding settings and provider limits

Settings has a search field above its section sidebar. Search accepts Russian and
English labels and descriptions regardless of the interface language. Words are
matched together, without case sensitivity. Choose a result with the mouse or
Tab/Enter to open its section and focus the setting. Clear the field to return to
the normal sidebar. Search never changes saved preferences.

When adding a SettingGroup, include its translation keys in
`features/settings/settingsSearch.ts` so its destination remains discoverable.
