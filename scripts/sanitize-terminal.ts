/**
 * Terminal-output sanitizer for the manual test harness.
 *
 * MainWP Dashboard JSON responses are untrusted. JSON.parse turns a unicode
 * escape (backslash-u-001b) in a response field into a raw ESC byte, so
 * interpolating a remote-derived value (a theme slug, a site id, a plugin
 * slug) straight into console.log lets the Dashboard drive ANSI/OSC terminal
 * sequences on the operator's terminal: spoof or hide output, rewrite the
 * window title, or write the clipboard via OSC 52.
 *
 * sanitizeForTerminal neutralizes that at the print boundary. It coerces any
 * value to a string (so a hostile non-string field cannot throw or leak
 * "[object Object]" past a bad `as` cast) and replaces every C0/C1 control
 * character with its printable backslash-uXXXX form. Escaping rather than
 * stripping is deliberate: this is a debugging harness, so an operator who
 * sees an escaped control byte in a slug learns the value carried something
 * odd. Clean, ordinary values pass through byte-for-byte unchanged.
 */
export function sanitizeForTerminal(value: unknown): string {
  const str = typeof value === 'string' ? value : String(value);
  let out = '';
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    // C0 controls (U+0000..U+001F), DEL (U+007F), C1 controls (U+0080..U+009F).
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out;
}
