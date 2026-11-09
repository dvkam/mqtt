import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.each([
  { defect: 'out-of-range byte', connack: '[0x20, 3, 256, 0, 0]' },
  { defect: 'missing byte', connack: '[0x20, 3, , 0, 0]' },
  { defect: 'missing frame', connack: '' },
])(
  'rejects $defect in an installed session reply',
  ({ connack }: Readonly<{ connack: string }>) => {
    const consumerDirectory = mkdtempSync(join(tmpdir(), 'mqtt-packed-session-'));
    const fixture = join(consumerDirectory, 'websocket-session.mjs');
    try {
      writeFileSync(
        fixture,
        `export const mqttSession = () => [
          ${connack},
          [0x90, 4, 0, 1, 0, 0],
          [0x30, 24, 0, 9, 99, 105, 47, 110, 97, 116, 105, 118, 101, 0, 110, 97, 116, 105, 118, 101, 32, 104, 101, 108, 108, 111],
          [0xd0, 0],
        ];
        export const mqttClientSession = () => ({ topic: 'ci/browser-client', payload: [104, 101, 108, 108, 111] });`,
      );
      const entry = fileURLToPath(new URL('./packed/websocket-session-check.ts', import.meta.url));
      const result = spawnSync(process.execPath, [entry, consumerDirectory, 'ws://127.0.0.1'], {
        encoding: 'utf8',
        timeout: 8000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid packed session reply frame');
    } finally {
      rmSync(fixture, { force: true });
      rmdirSync(consumerDirectory);
    }
  },
  10_000,
);
