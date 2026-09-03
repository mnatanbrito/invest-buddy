import { spawnSync } from 'node:child_process';

/**
 * Drift gate for `schema.ts` vs the committed migrations.
 *
 * `drizzle-kit generate` (0.31.10) is not safe to trust by exit code alone: run
 * non-interactively it prints `Error: Interactive prompts require a TTY terminal`
 * on a column rename and `TransformError` on a `schema.ts` syntax error, yet
 * **exits 0 and writes nothing**. So `drizzle-kit generate && git diff` waves
 * destructive drift straight through. This script treats those messages — and a
 * non-zero status, and a spawn error — as failures, then separately fails if
 * generate produced or changed anything under `server/db/migrations`.
 */

const FAILURE_MARKERS = ['Error', 'TTY', 'TransformError', 'Please provide'];

const generate = spawnSync('pnpm', ['exec', 'drizzle-kit', 'generate'], {
  encoding: 'utf8',
});
const output = `${generate.stdout ?? ''}${generate.stderr ?? ''}`;

if (output.trim().length > 0) process.stdout.write(`${output}\n`);

const marker = FAILURE_MARKERS.find((m) => output.includes(m));
if (marker !== undefined || generate.status !== 0 || generate.error) {
  const reason = generate.error
    ? `could not run drizzle-kit generate: ${generate.error.message}`
    : marker !== undefined
      ? `drizzle-kit generate reported a problem (matched "${marker}")`
      : `drizzle-kit generate exited with status ${String(generate.status)}`;
  process.stderr.write(
    `db:check: ${reason}. ` +
      'Fix schema.ts (a column rename needs a hand-written migration) and re-run.\n',
  );
  process.exit(1);
}

const status = spawnSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', 'server/db/migrations'],
  { encoding: 'utf8' },
);
const drift = (status.stdout ?? '').trim();
if (drift.length > 0) {
  process.stderr.write(
    'db:check: schema.ts has drifted from server/db/migrations:\n' +
      `${drift}\n` +
      'Run `pnpm db:generate`, review the generated SQL, and commit it.\n',
  );
  process.exit(1);
}

process.stdout.write('db:check: schema.ts and server/db/migrations are in sync\n');
