import { describe, it, expect } from 'vitest';
import { sanitizeForTerminal } from './sanitize-terminal.js';

// Control bytes are built at runtime with String.fromCharCode so this source
// file stays pure printable ASCII. At runtime these are the exact bytes
// JSON.parse yields from a remote response field carrying a unicode escape.
const ESC = String.fromCharCode(0x1b); // U+001B ESC
const BEL = String.fromCharCode(0x07); // U+0007 BEL (OSC terminator)
const DEL = String.fromCharCode(0x7f); // U+007F DEL
const C1 = String.fromCharCode(0x9b); // U+009B CSI (C1 control)

describe('sanitizeForTerminal', () => {
  it('leaves an ordinary theme/plugin slug unchanged', () => {
    expect(sanitizeForTerminal('twentytwentyfour')).toBe('twentytwentyfour');
    expect(sanitizeForTerminal('hello-dolly/hello.php')).toBe('hello-dolly/hello.php');
  });

  it('neutralizes an ANSI SGR color escape hidden in a slug', () => {
    const hostile = ESC + '[31mFAKE';
    const cleaned = sanitizeForTerminal(hostile);
    expect(cleaned).not.toContain(ESC);
    expect(cleaned).toBe('\\u001b[31mFAKE');
  });

  it('neutralizes an OSC 52 clipboard-write sequence', () => {
    // ESC ] 52 ; c ; <base64> BEL
    const hostile = ESC + ']52;c;ZXZpbA==' + BEL;
    const cleaned = sanitizeForTerminal(hostile);
    expect(cleaned).not.toContain(ESC);
    expect(cleaned).not.toContain(BEL);
    expect(cleaned).toContain('\\u001b');
    expect(cleaned).toContain('\\u0007');
  });

  it('escapes DEL and C1 control bytes', () => {
    expect(sanitizeForTerminal('a' + DEL + 'b')).toBe('a\\u007fb');
    expect(sanitizeForTerminal('a' + C1 + 'c')).toBe('a\\u009bc');
  });

  it('coerces non-string values without throwing or leaking [object Object]', () => {
    expect(sanitizeForTerminal(42)).toBe('42');
    expect(sanitizeForTerminal(null)).toBe('null');
    expect(sanitizeForTerminal(undefined)).toBe('undefined');
    // A hostile object whose coercion carries an escape is still neutralized.
    const evil = {
      toString() {
        return ESC + '[2J';
      },
    };
    const cleaned = sanitizeForTerminal(evil);
    expect(cleaned).not.toContain(ESC);
    expect(cleaned).toBe('\\u001b[2J');
  });

  it('preserves normal whitespace between printable characters', () => {
    expect(sanitizeForTerminal('active theme')).toBe('active theme');
  });
});
