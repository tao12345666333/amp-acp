import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { getTerminalAuthCommand, isAuthError } from './server.js';

describe('isAuthError', () => {
  it('detects missing API key login flow errors', () => {
    expect(isAuthError('No API key found. Starting login flow...')).toBe(true);
    expect(isAuthError('Failed to parse JSON response, raw line: No API key found. Starting login flow...')).toBe(true);
  });

  it('does not misclassify unrelated parse errors', () => {
    expect(isAuthError('Failed to parse JSON response, raw line: Unexpected token')).toBe(false);
  });
});

describe('getTerminalAuthCommand', () => {
  it('uses execPath when argv1 is bunfs virtual path', () => {
    expect(getTerminalAuthCommand('/$bunfs/root/amp-acp', '/tmp/amp-acp')).toBe('/tmp/amp-acp');
  });

  it('resolves argv1 path for non-binary execution', () => {
    expect(getTerminalAuthCommand('./dist/index.js', '/usr/bin/bun')).toBe(path.resolve('./dist/index.js'));
  });
});
