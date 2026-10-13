#!/bin/sh
# $VISUAL for macOS Claude sessions. Claude Code exposes no select-all, so CanvasTTY
# acts on the whole prompt draft through Claude's external-editor round trip (Ctrl+G):
# it adds one line per Ctrl+G it sends to CANVASTTY_DRAFT_DIR/request. A "cancel" line
# stands for a Ctrl+G that Claude took too long to pick up: it changes nothing and opens
# no editor. Without a request this is an ordinary Ctrl+G and the person's own editor opens.
file=$1
dir=$CANVASTTY_DRAFT_DIR
if [ -n "$dir" ] && [ -s "$dir/request" ]; then
  action=$(head -n 1 "$dir/request")
  tail -n +2 "$dir/request" > "$dir/request.next"
  mv -f "$dir/request.next" "$dir/request"
  [ -s "$dir/request" ] || rm -f "$dir/request"
  [ "$action" = cancel ] && exit 0
  cp "$file" "$dir/draft.txt"
  case "$action" in
    cut|clear) : > "$file" ;;
  esac
  : > "$dir/done"
  exit 0
fi
if [ -n "$CANVASTTY_DRAFT_EDITOR" ]; then
  exec /bin/sh -c "$CANVASTTY_DRAFT_EDITOR \"\$1\"" canvastty-editor "$file"
fi
exec vi "$file"
