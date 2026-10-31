# macOS stability changes

These changes apply to macOS. Linux and Windows retain their existing shutdown
failure behavior and v2 history writer. No security audit is part of this work.

- Quit continues independent cleanup after an optional service rejects, including
  terminal shutdown and the final history save. Failures still produce a warning.
- Large history snapshots (at least 1 MiB) use gzip level 1 in an atomic v3 JSON
  envelope. Compression runs in Node's worker pool. Events, quota observations,
  collection health and reader cursors remain in the same transaction. The collection
  frequency, retention and fsync/rename durability protocol are unchanged. Small
  snapshots remain v2. Both versions load on Mac.
- The usage report constrains its grid rows to the available height on Mac; a
  shorter header and wrapping metadata preserve space at small window heights.

## History rollback

Older builds cannot read the compressed v3 envelope. They preserve it untouched
and report an unsupported format. Before downgrading, quit CanvasTTY and export:

```sh
node scripts/export-mac-usage-history.mjs \
  "$HOME/Library/Application Support/canvastty/usage-history.json" \
  /absolute/path/to/new-usage-history-v2.json
```

The exporter never modifies the source and refuses to overwrite the destination.
Keep the original snapshot as a backup, then put the exported file in the older
build's `userData` directory as `usage-history.json` while the app is stopped.
No network or extra packages are needed.

## Verification

`node --test tests/mac-shutdown.test.mjs tests/mac-history-snapshot.test.mjs`
exercises cleanup failures, v2/v3 round trips, preservation of damaged snapshots,
rollback export, and unchanged behavior on other platforms. On a Mac,
`node scripts/smoke-usage-ui-packaged.mjs --app /path/to/CanvasTTY.app --mac-layout --keep`
checks the actual packaged renderer at 920×620, 1280×800 and 1440×900 with UI scales
85%, 100% and 125%, across all five usage sections. Its data and profile are synthetic.

Passing these checks is not a claim of zero defects or long-duration acceptance.
