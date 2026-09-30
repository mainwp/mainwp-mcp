import { describe, expect, it, vi } from 'vitest';
import { MCP_ERROR_CODES } from './errors.js';
import { DEPTH_LIMIT_MARKER } from './security.js';
import { createWriteOnlyRedactor } from './write-only.js';

const schema = { type: 'object', properties: { secret: { writeOnly: true } } };

describe('createWriteOnlyRedactor', () => {
  // One row per input shape the redactor must handle: what text() and deep()
  // must return for a result that echoes, or merely resembles, the value.
  it.each([
    {
      shape: 'long string, verbatim and inside text',
      secret: 'hunter22',
      text: ['pw hunter22 rejected', 'pw [redacted] rejected'],
      deep: [
        { note: 'hunter22', same: 'hunter22' },
        { note: '[redacted]', same: '[redacted]' },
      ],
    },
    {
      shape: 'string as an object key is replaced only on an exact match',
      secret: 'token',
      text: ['token', '[redacted]'],
      deep: [
        { token: 1, lookup_token: 2 },
        { '[redacted]': 1, lookup_token: 2 },
      ],
    },
    {
      shape: 'short string is too short to redact without mangling output',
      secret: 'ok',
      text: ['status ok, lookup ok', 'status ok, lookup ok'],
      deep: [
        { status: 'ok', lookup_token: 'x' },
        { status: 'ok', lookup_token: 'x' },
      ],
    },
    {
      shape: 'long number, bounded by non-alphanumerics',
      secret: 918273,
      text: ['pin 918273, 9182730, a918273f', 'pin [redacted], 9182730, a918273f'],
      deep: [
        { pin: 918273, other: 9182730 },
        { pin: '[redacted]', other: 9182730 },
      ],
    },
    {
      shape: 'short number such as a zero timestamp is left alone',
      secret: 0,
      text: ['total 0, revision a0f3', 'total 0, revision a0f3'],
      deep: [
        { total: 0, revision: 'a0f3' },
        { total: 0, revision: 'a0f3' },
      ],
    },
    {
      shape: 'all-digit string, echoed as text or as a JSON number after a PHP int cast',
      secret: '0482913',
      text: ['pin 0482913, 10482913', 'pin [redacted], 10482913'],
      deep: [
        { pin: 482913, other: 1482913 },
        { pin: '[redacted]', other: 1482913 },
      ],
    },
    {
      shape: 'all-digit string matches whole digit runs only, not inside longer ids',
      secret: '2026',
      text: ['created 2026-09-30, id 12026', 'created [redacted]-09-30, id 12026'],
      deep: [
        { year: 2026, count: 12026 },
        { year: '[redacted]', count: 12026 },
      ],
    },
    {
      shape: 'all-digit string whose number cast is short leaves that number alone',
      secret: '0007',
      text: ['code 0007, 7 items', 'code [redacted], 7 items'],
      deep: [{ items: 7 }, { items: 7 }],
    },
    {
      shape: 'boolean is never collected',
      secret: true,
      text: ['true', 'true'],
      deep: [{ enabled: true }, { enabled: true }],
    },
  ])('$shape', ({ secret, text, deep }) => {
    const redactor = createWriteOnlyRedactor(schema, { secret });

    expect(redactor.text(text[0] as string)).toBe(text[1]);
    expect(redactor.deep(deep[0])).toEqual(deep[1]);
  });

  it.each([
    { shape: 'long string', input: { secret: 'hunter22' }, carried: true },
    { shape: 'short string', input: { secret: 'ok' }, carried: true },
    { shape: 'boolean', input: { secret: true }, carried: true },
    { shape: 'null', input: { secret: null }, carried: true },
    { shape: 'empty object', input: { secret: {} }, carried: true },
    { shape: 'no writeOnly field', input: {}, carried: false },
    { shape: 'no input', input: undefined, carried: false },
  ])('reports whether the call carried writeOnly input: $shape', ({ input, carried }) => {
    expect(createWriteOnlyRedactor(schema, input).carriesWriteOnly).toBe(carried);
  });

  it.each([
    {
      shape: 'writeOnly array from a comma string',
      inputSchema: {
        type: 'object',
        properties: { secret: { type: 'array', writeOnly: true, items: { type: 'string' } } },
      },
      input: { secret: 'ns1.private-host.example,ns2.private-host.example' },
      echo: ['ns1.private-host.example', 'ns2.private-host.example'],
      expectedEcho: ['[redacted]', '[redacted]'],
      carried: true,
    },
    {
      shape: 'writeOnly items from a comma string',
      inputSchema: {
        type: 'object',
        properties: { secret: { type: 'array', items: { type: 'string', writeOnly: true } } },
      },
      input: { secret: 'TOKENAAAA1,TOKENBBBB2' },
      echo: ['TOKENAAAA1', 'TOKENBBBB2'],
      expectedEcho: ['[redacted]', '[redacted]'],
      carried: true,
    },
    {
      shape: 'writeOnly items from object values',
      inputSchema: {
        type: 'object',
        properties: { secret: { type: 'array', items: { type: 'string', writeOnly: true } } },
      },
      input: { secret: { '0': 'TOKENAAAA1' } },
      echo: ['TOKENAAAA1'],
      expectedEcho: ['[redacted]'],
      carried: true,
    },
    {
      shape: 'comma string without an array schema',
      inputSchema: {
        type: 'object',
        properties: { secret: { type: 'string', writeOnly: true } },
      },
      input: { secret: 'TOKENAAAA1,TOKENBBBB2' },
      echo: ['TOKENAAAA1', 'TOKENBBBB2'],
      expectedEcho: ['TOKENAAAA1', 'TOKENBBBB2'],
      carried: true,
    },
  ])(
    'redacts WordPress list coercion: $shape',
    ({ inputSchema, input, echo, expectedEcho, carried }) => {
      const redactor = createWriteOnlyRedactor(inputSchema, input);

      expect(redactor.carriesWriteOnly).toBe(carried);
      expect(redactor.deep(echo)).toEqual(expectedEcho);
    }
  );

  it.each([
    { shape: 'leading whitespace', secret: ' 5551234', expected: '[redacted]' },
    { shape: 'trailing whitespace', secret: '5551234 ', expected: '[redacted]' },
    { shape: 'leading plus', secret: '+5551234', expected: '[redacted]' },
    { shape: 'exponent', secret: '5.551234e6', expected: '[redacted]' },
    { shape: 'hexadecimal prefix', secret: '0x5551234', expected: 5551234 },
  ])('redacts PHP numeric cast: $shape', ({ secret, expected }) => {
    const redactor = createWriteOnlyRedactor(
      { type: 'object', properties: { secret: { type: 'integer', writeOnly: true } } },
      { secret }
    );

    expect(redactor.deep({ echoed: 5551234 })).toEqual({ echoed: expected });
  });

  it('redacts a verbatim echo of a writeOnly object even when its leaves are short', () => {
    const redactor = createWriteOnlyRedactor(schema, { secret: { pin: 42, status: 'ok' } });

    expect(redactor.deep({ echo: { status: 'ok', pin: 42 } })).toEqual({ echo: '[redacted]' });
    expect(redactor.deep({ pin: 42, status: 'ok', extra: 1 })).toEqual({
      pin: 42,
      status: 'ok',
      extra: 1,
    });
  });

  it('redacts an exact numeric writeOnly object key without changing longer keys', () => {
    const redactor = createWriteOnlyRedactor(
      { type: 'object', properties: { pin: { writeOnly: true } } },
      { pin: 1234 }
    );

    expect(redactor.deep({ '1234': 'x', '12345': 'y' })).toEqual({
      '[redacted]': 'x',
      '12345': 'y',
    });
  });

  // The pattern comes from the Dashboard and the key from the caller, so the
  // pattern is never compiled or run: every key under a writeOnly
  // patternProperties schema is private, whether or not it would match.
  it.each([
    ['a matching pattern', '^x_.*_secret$', 'x_db_secret'],
    ['a pattern the key does not match', '^never$', 'x_db_secret'],
    ['a quantified alternation', '^(?:foo|bar)+$', 'foobar'],
    ['a nested quantifier', '^(a+)+$', `${'a'.repeat(40)}!`],
    ['a backreference', '^(x)\\1$', 'xx'],
    ['an invalid pattern', '[', 'x_db_secret'],
    ['a key over 256 characters', '^x_.*_secret$', `x_${'a'.repeat(291)}_secret`],
  ])('treats a key under writeOnly patternProperties as private: %s', (_name, pattern, key) => {
    const redactor = createWriteOnlyRedactor(
      { type: 'object', patternProperties: { [pattern]: { type: 'string', writeOnly: true } } },
      { [key]: 'longsecretvalue' }
    );

    expect(redactor.deep({ reflected: 'longsecretvalue' })).toEqual({ reflected: '[redacted]' });
  });

  it('does not run a backtracking patternProperties pattern against a long key', () => {
    const redactor = createWriteOnlyRedactor(
      {
        type: 'object',
        patternProperties: { '^(a*a*a*a*a*a*a*a*a*a*b)$': { writeOnly: true } },
      },
      { ['a'.repeat(5000)]: 'longsecretvalue' }
    );

    expect(redactor.deep({ reflected: 'longsecretvalue' })).toEqual({ reflected: '[redacted]' });
  });

  it.each([
    {
      shape: 'deep writeOnly input',
      makeCase: () => {
        let value: Record<string, unknown> = { leaf: 'private-value' };
        for (let depth = 0; depth < 100; depth++) value = { nested: value };
        return { inputSchema: schema, input: { secret: value } };
      },
    },
    {
      shape: 'writeOnly scalar at the depth cap',
      makeCase: () => {
        let value: Record<string, unknown> = { leaf: 'private-value' };
        for (let depth = 0; depth < 98; depth++) value = { nested: value };
        return { inputSchema: schema, input: { secret: value } };
      },
    },
    {
      shape: 'nested combinators without input descent',
      makeCase: () => {
        let inputSchema: Record<string, unknown> = { writeOnly: true };
        const keywords = ['allOf', 'anyOf', 'oneOf'];
        for (let depth = 0; depth < 100; depth++) {
          inputSchema = { [keywords[depth % keywords.length]]: [inputSchema] };
        }
        return { inputSchema, input: { secret: 'private-value' } };
      },
    },
    {
      shape: 'cyclic writeOnly input',
      makeCase: () => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return { inputSchema: schema, input: { secret: value } };
      },
    },
  ])('refuses $shape at the depth cap', ({ makeCase }) => {
    const { inputSchema, input } = makeCase();
    expect(() => createWriteOnlyRedactor(inputSchema, input)).toThrowError(
      expect.objectContaining({ code: MCP_ERROR_CODES.INVALID_PARAMS })
    );
  });

  it('removes a result scalar reached at the depth cap', () => {
    const redactor = createWriteOnlyRedactor(schema, { secret: 'private-value' });
    let response: unknown = 'public';
    for (let depth = 0; depth < 100; depth++) response = { nested: response };

    const result = redactor.deep(response) as Record<string, unknown>;
    let leaf: unknown = result;
    for (let depth = 0; depth < 100; depth++) {
      leaf = (leaf as Record<string, unknown>).nested;
    }
    expect(leaf).toBe(DEPTH_LIMIT_MARKER);
  });

  it('skips compound serialization when only private scalars were collected', () => {
    const redactor = createWriteOnlyRedactor(schema, { secret: 'longsecretvalue' });
    let response: Record<string, unknown> = { value: 'public' };
    for (let depth = 0; depth < 200; depth++) {
      response = { nested: response };
    }
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(redactor.deep(response)).toBeDefined();
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it('matches a private compound within the serialization budget', () => {
    const redactor = createWriteOnlyRedactor(schema, { secret: { pin: 42, status: 'ok' } });

    expect(redactor.deep({ echo: { status: 'ok', pin: 42 }, other: 'x'.repeat(100000) })).toEqual({
      echo: '[redacted]',
      other: 'x'.repeat(100000),
    });
  });

  it('matches the longer of overlapping values first', () => {
    const redactor = createWriteOnlyRedactor(schema, { secret: ['abcd', 'abcdefgh'] });

    expect(redactor.text('abcdefgh abcd')).toBe('[redacted] [redacted]');
  });
});
