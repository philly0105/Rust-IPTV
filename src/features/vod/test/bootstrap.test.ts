/**
 * The bootstrap in src/main.tsx (data-perf area; it has no test folder of its own).
 * imageBaseReady's own timing is covered in src/ui/test/images.test.tsx.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const main = readFileSync(join(__dirname, '..', '..', '..', 'main.tsx'), 'utf8');

describe('bootstrap', () => {
  it('waits for the image cache base in parallel with the locale, before the first render', () => {
    // In parallel: the web path (imageBaseReady settled at once) is not delayed, and desktop waits
    // at most the longer of the two.
    expect(main).toMatch(/Promise\.all\(\[initI18n\(\), imageBaseReady\(\)\]\)\.then\(\(\) => \{\s*createRoot\(root\)\.render\(/);
    expect(main).not.toMatch(/await initI18n\(\)|initI18n\(\)\.then/);
  });
});
