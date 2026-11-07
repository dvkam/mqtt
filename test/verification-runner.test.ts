import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('rejects an unverified TLC jar before attempting Java execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mqtt-verification-'));
  try {
    const jar = join(directory, 'invalid.jar');
    writeFileSync(jar, 'not the published TLC artifact');
    const result = spawnSync(process.execPath, ['verification/check.ts'], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, TLC_JAR: jar, JAVA: join(directory, 'unavailable-java') },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Use the published TLC 1.7.4 jar');
    expect(result.stderr).not.toContain('ENOENT');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
