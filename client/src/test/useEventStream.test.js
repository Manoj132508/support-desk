import { describe, expect, it } from 'vitest';
import { parseFrames } from '../lib/useEventStream.js';

/**
 * The SSE frame parser.
 *
 * Tested exhaustively and in isolation because this is where the edge cases
 * live. The network plumbing around it is thin; the parser is the part that
 * silently drops a token when a packet boundary lands mid-frame.
 */
describe('parseFrames', () => {
  it('parses a single complete frame', () => {
    const { frames, rest } = parseFrames('event: token\ndata: "hi"\n\n');
    expect(frames).toEqual([{ event: 'token', data: 'hi' }]);
    expect(rest).toBe('');
  });

  it('parses several frames from one chunk', () => {
    const { frames } = parseFrames(
      'event: token\ndata: "a"\n\nevent: token\ndata: "b"\n\n',
    );
    expect(frames.map((f) => f.data)).toEqual(['a', 'b']);
  });

  it('holds an incomplete frame back as rest', () => {
    const { frames, rest } = parseFrames('event: token\ndata: "a"\n\nevent: tok');
    expect(frames).toHaveLength(1);
    expect(rest).toBe('event: tok');
  });

  it('reassembles a frame split across two chunks', () => {
    // This is the bug the `rest` mechanism exists to prevent: without it, a
    // frame straddling a packet boundary is dropped and the token never
    // reaches the UI.
    const first = parseFrames('event: token\ndata: "he');
    expect(first.frames).toHaveLength(0);

    const second = parseFrames(first.rest + 'llo"\n\n');
    expect(second.frames).toEqual([{ event: 'token', data: 'hello' }]);
  });

  it('parses JSON payloads', () => {
    const { frames } = parseFrames(
      'event: proposal\ndata: {"id":"prop_1","actionType":"order.cancel"}\n\n',
    );
    expect(frames[0].data).toEqual({ id: 'prop_1', actionType: 'order.cancel' });
  });

  it('keeps a non-JSON payload as a string', () => {
    const { frames } = parseFrames('event: token\ndata: plain text\n\n');
    expect(frames[0].data).toBe('plain text');
  });

  it('joins multi-line data with newlines', () => {
    const { frames } = parseFrames('event: token\ndata: line one\ndata: line two\n\n');
    expect(frames[0].data).toBe('line one\nline two');
  });

  it('ignores comment / keep-alive lines', () => {
    const { frames } = parseFrames(': keep-alive\nevent: token\ndata: "a"\n\n');
    expect(frames).toEqual([{ event: 'token', data: 'a' }]);
  });

  it('defaults the event name to "message"', () => {
    const { frames } = parseFrames('data: "a"\n\n');
    expect(frames[0].event).toBe('message');
  });

  it('handles CRLF line endings', () => {
    const { frames } = parseFrames('event: token\r\ndata: "a"\r\n\r\n');
    expect(frames).toEqual([{ event: 'token', data: 'a' }]);
  });

  it('drops a frame with no data lines', () => {
    const { frames } = parseFrames('event: token\n\n');
    expect(frames).toHaveLength(0);
  });
});
