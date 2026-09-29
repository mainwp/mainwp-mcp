import { describe, expect, it } from 'vitest';
import { parseNpmPackJson } from './npm-pack-json.js';

const record = {
  id: '@mainwp/mcp@1.3.0',
  name: '@mainwp/mcp',
  version: '1.3.0',
  filename: 'mainwp-mcp-1.3.0.tgz',
  shasum: 'abc123',
  integrity: 'sha512-xyz',
  files: [],
};
const other = { ...record, id: 'other@2.0.0', name: 'other', filename: 'other-2.0.0.tgz' };
const { filename: _filename, ...withoutFilename } = record;

describe('parseNpmPackJson', () => {
  it.each([
    ['npm 10 array', JSON.stringify([record]), 1, [record.filename]],
    [
      'npm 12 object keyed by package name',
      JSON.stringify({ [record.name]: record }),
      1,
      [record.filename],
    ],
    ['npm 10 array of two', JSON.stringify([record, other]), 2, [record.filename, other.filename]],
    [
      'npm 12 object of two',
      JSON.stringify({ [record.name]: record, [other.name]: other }),
      2,
      [record.filename, other.filename],
    ],
  ])('accepts %s', (_label, stdout, expectedCount, filenames) => {
    expect(parseNpmPackJson(stdout, expectedCount).map(entry => entry.filename)).toEqual(filenames);
  });

  it.each([
    ['zero records (array)', '[]', 1, 'produced 0 package records, expected 1'],
    ['zero records (object)', '{}', 1, 'produced 0 package records, expected 1'],
    [
      'two records where one was expected',
      JSON.stringify([record, other]),
      1,
      'produced 2 package records, expected 1',
    ],
    [
      'two records keyed by name where one was expected',
      JSON.stringify({ [record.name]: record, [other.name]: other }),
      1,
      'produced 2 package records, expected 1',
    ],
    ['non-JSON output', 'npm WARN something\n', 1, 'not JSON'],
    ['null', 'null', 1, 'got null'],
    ['a string', '"mainwp-mcp-1.3.0.tgz"', 1, 'got string'],
    ['a record without filename', JSON.stringify([withoutFilename]), 1, 'record 0 has no filename'],
    [
      'a record that is not an object',
      JSON.stringify({ [record.name]: 'x' }),
      1,
      'record 0 is string',
    ],
  ])('refuses %s', (_label, stdout, expectedCount, message) => {
    expect(() => parseNpmPackJson(stdout, expectedCount)).toThrow(message);
  });
});
