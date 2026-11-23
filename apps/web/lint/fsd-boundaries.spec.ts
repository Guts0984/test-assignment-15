import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const src = resolve(__dirname, '../src');

const fixtures: Record<string, string> = {
  'entities/zz-ent/index.ts': "export { entValue } from './model/value';\n",
  'entities/zz-ent/model/value.ts': 'export const entValue = 1;\n',
  'features/zz-feat-a/index.ts': "export { featA } from './model/a';\n",
  'features/zz-feat-a/model/a.ts': 'export const featA = 1;\n',
  'features/zz-feat-b/index.ts': 'export const featB = 1;\n',
  'widgets/zz-widget/index.ts': 'export const widget = 1;\n',
};

const lint = async (relPath: string, code: string): Promise<readonly string[]> => {
  const filePath = resolve(src, relPath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, code);
  // The boundaries plugin resolves element patterns against process.cwd(), so lint from the repo root.
  const run = spawnSync(
    resolve(repoRoot, 'node_modules/.bin/eslint'),
    ['--format', 'json', filePath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const parsed = JSON.parse(run.stdout) as { messages: { ruleId: string | null }[] }[];
  return (parsed[0]?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
};

beforeAll(() => {
  for (const [rel, content] of Object.entries(fixtures)) {
    const full = resolve(src, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
});

afterAll(() => {
  for (const dir of [
    'entities/zz-ent',
    'features/zz-feat-a',
    'features/zz-feat-b',
    'widgets/zz-widget',
  ]) {
    rmSync(resolve(src, dir), { recursive: true, force: true });
  }
});

describe('FSD boundary lint', () => {
  it('allows a higher layer to import a lower slice through its public API', async () => {
    const rules = await lint(
      'features/zz-feat-b/ui/x.ts',
      "import { entValue } from '@/entities/zz-ent';\nexport const v = entValue;\n",
    );
    expect(rules).toEqual([]);
  });

  it('rejects an import from a higher layer (entity importing a feature)', async () => {
    const rules = await lint(
      'entities/zz-ent/model/bad.ts',
      "import { featB } from '@/features/zz-feat-b';\nexport const v = featB;\n",
    );
    expect(rules).toContain('boundaries/element-types');
  });

  it('rejects sideways imports between slices of the same layer', async () => {
    const rules = await lint(
      'features/zz-feat-b/ui/bad.ts',
      "import { featA } from '@/features/zz-feat-a';\nexport const v = featA;\n",
    );
    expect(rules).toContain('boundaries/element-types');
  });

  it('rejects deep imports that bypass a slice public API', async () => {
    const rules = await lint(
      'widgets/zz-widget/ui/bad.ts',
      "import { entValue } from '@/entities/zz-ent/model/value';\nexport const v = entValue;\n",
    );
    expect(rules).toContain('boundaries/entry-point');
  });

  it('allows imports inside the same slice', async () => {
    const rules = await lint(
      'features/zz-feat-a/ui/ok.ts',
      "import { featA } from '../model/a';\nexport const v = featA;\n",
    );
    expect(rules).toEqual([]);
  });
});
