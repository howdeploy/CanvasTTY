#!/bin/sh
# $VISUAL for macOS Claude sessions. Claude Code exposes no select-all, so CanvasTTY
# acts on the whole prompt draft through Claude's external-editor round trip (Ctrl+G).
# Each action is a file req.<n> in CANVASTTY_DRAFT_DIR, claimed here by renaming it.
# A cancel.<n> stands for a Ctrl+G that Claude took too long to pick up: when no request
# is waiting, one is used up and nothing changes, so a late Ctrl+G opens no editor.
# With neither, this is an ordinary Ctrl+G and the person's own editor opens.
#
# A background Claude session may be shown by another card than the one that started it,
# so after this card's own folder the other cards' folders are looked at for a request
# (inside agent isolation they are hidden, and only the own folder is seen). A cancel is
# only ever this card's own: another card's never costs a Ctrl+G here.
file=$1
dir=$CANVASTTY_DRAFT_DIR
# Only Claude's own prompt file: a program Claude runs (git commit, crontab -e) gets the person's editor.
case "${file##*/}" in
  claude-prompt-*.md) ;;
  *) dir= ;;
esac
# Sets found (a folder) and id to the oldest <kind>.<n> in the given folders, in order.
find_oldest() {
  kind=$1
  shift
  for found in "$@"; do
    [ -d "$found" ] || continue
    id=$(ls "$found" 2>/dev/null | sed -n "s/^$kind\.\([0-9][0-9]*\)\$/\1/p" | sort -n | head -n 1)
    [ -n "$id" ] && return 0
  done
  return 1
}
if [ -n "$dir" ]; then
  while find_oldest req "$dir" "${dir%/*}"/*; do
    # Renaming is atomic: CanvasTTY cancels a request the same way, so only one side gets it.
    if ! mv "$found/req.$id" "$found/claimed.$id" 2>/dev/null; then
      { [ -e "$found/req.$id" ] || [ -L "$found/req.$id" ]; } && exit 1
      continue
    fi
    action=$(head -n 1 "$found/claimed.$id")
    rm -f "$found/claimed.$id"
    case "$action" in
      copy|cut|clear) ;;
      *) exit 0 ;;
    esac
    rm -f "$found/draft.$id"
    # Without a saved copy the draft is left as it was.
    cp "$file" "$found/draft.$id" || exit 1
    case "$action" in
      cut|clear) : > "$file" ;;
    esac
    : > "$found/done.$id"
    exit 0
  done
  # A cancel that cannot be removed is not used up: this Ctrl+G opens the editor.
  if find_oldest cancel "$dir" && rm "$found/cancel.$id" 2>/dev/null; then
    exit 0
  fi
fi
if [ -n "$CANVASTTY_DRAFT_EDITOR" ]; then
  exec /bin/sh -c "$CANVASTTY_DRAFT_EDITOR \"\$1\"" canvastty-editor "$file"
fi
exec vi "$file"
