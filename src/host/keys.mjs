/**
 * Whether a key sequence presses Pi's `app.suspend` key, which detaches from a host, where Pi does not suspend.
 * `tui` is Pi's pi-tui, and `keybindings` Pi's `KeybindingsManager`.
 */
export function detachMatcher(tui, keybindings) {
  return sequence => !tui.isKeyRelease(sequence) && keybindings.matches(sequence, 'app.suspend');
}
