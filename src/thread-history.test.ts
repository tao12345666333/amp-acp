import { describe, expect, it } from 'bun:test';
import { exportThreadMessages, type ExportedThreadMessage } from './thread-history.js';

const MESSAGE: ExportedThreadMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }] };

describe('exportThreadMessages', () => {
  it('returns messages from the first attempt without retrying', async () => {
    let calls = 0;
    const messages = await exportThreadMessages(async () => {
      calls++;
      return [MESSAGE];
    }, 'T-01234567-89ab-cdef-0123-456789abcdef', '/tmp', 5, 0);
    expect(messages).toEqual([MESSAGE]);
    expect(calls).toBe(1);
  });

  it('retries while the export comes back empty', async () => {
    let calls = 0;
    const messages = await exportThreadMessages(async () => {
      calls++;
      return calls < 3 ? [] : [MESSAGE];
    }, 'T-01234567-89ab-cdef-0123-456789abcdef', '/tmp', 5, 0);
    expect(messages).toEqual([MESSAGE]);
    expect(calls).toBe(3);
  });

  it('returns an empty list after exhausting all attempts', async () => {
    let calls = 0;
    const messages = await exportThreadMessages(async () => {
      calls++;
      return [];
    }, 'T-01234567-89ab-cdef-0123-456789abcdef', '/tmp', 3, 0);
    expect(messages).toEqual([]);
    expect(calls).toBe(3);
  });

  it('propagates export errors without retrying', async () => {
    let calls = 0;
    await expect(exportThreadMessages(async () => {
      calls++;
      throw new Error('export failed');
    }, 'T-01234567-89ab-cdef-0123-456789abcdef', '/tmp', 5, 0)).rejects.toThrow('export failed');
    expect(calls).toBe(1);
  });
});
