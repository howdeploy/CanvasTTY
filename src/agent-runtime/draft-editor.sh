#!/bin/sh
# $VISUAL for macOS Claude sessions. Claude Code exposes no select-all, so CanvasTTY
# acts on the whole prompt draft through Claude's external-editor round trip (Ctrl+G).
# Each action is a file req.<n> in CANVASTTY_DRAFT_DIR, claimed here by renaming it.
# A cancel.<n> stands for a Ctrl+G that Claude took too long to pick up: when no request
# is waiting, one is used up and nothing changes, so a late Ctrl+G opens no editor.
# With neither, this is an ordinary Ctrl+G and the person's own editor opens.
file=$1
dir=$CANVASTTY_DRAFT_DIR
oldest() {
  ls "$dir" 2>/dev/null | sed -n "s/^$1\.\([0-9][0-9]*\)\$/\1/p" | sort -n | head -n 1
}
if [ -n "$dir" ] && [ -d "$dir" ]; then
  while id=$(oldest req) && [ -n "$id" ]; do
    # Renaming is atomic: CanvasTTY cancels a request the same way, so only one side gets it.
    if ! mv "$dir/req.$id" "$dir/claimed.$id" 2>/dev/null; then
      [ -e "$dir/req.$id" ] && exit 1
      continue
    fi
    action=$(head -n 1 "$dir/claimed.$id")
    rm -f "$dir/claimed.$id"
    case "$action" in
      copy|cut|clear) ;;
      *) exit 0 ;;
    esac
    rm -f "$dir/draft.$id"
    # Without a saved copy the draft is left as it was.
    cp "$file" "$dir/draft.$id" || exit 1
    case "$action" in
      cut|clear) : > "$file" ;;
    esac
    : > "$dir/done.$id"
    exit 0
  done
  id=$(oldest cancel)
  if [ -n "$id" ]; then
    rm -f "$dir/cancel.$id"
    exit 0
  fi
fi
if [ -n "$CANVASTTY_DRAFT_EDITOR" ]; then
  exec /bin/sh -c "$CANVASTTY_DRAFT_EDITOR \"\$1\"" canvastty-editor "$file"
fi
exec vi "$file"
