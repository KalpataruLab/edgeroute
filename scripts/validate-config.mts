// Run: pnpm validate-config [--strict] [file...]   (Node 22.6+)
// Uses the same validateConfig as the Worker, so a bad config fails here, not in KV.
// Default files: config.example.json and every config/*.json (committed route config per environment).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { validateConfig } from '../src/config.ts';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
let files = args.filter(a => !a.startsWith('--'));
if (!files.length) {
  files = existsSync('config.example.json') ? ['config.example.json'] : [];
  if (existsSync('config'))
    files.push(
      ...readdirSync('config')
        .filter(f => f.endsWith('.json'))
        .map(f => `config/${f}`)
    );
}

let failed = false;
for (const file of files) {
  const problems: string[] = [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const { warnings } = validateConfig(raw);
    for (const w of warnings) {
      console.warn(`${file}: warning: ${w}`);
      if (strict) failed = true;
    }
    // Files in config/ are committed: secrets belong in Wrangler secrets, not in git.
    if (file.startsWith('config/')) {
      for (const k of ['authSalt', 'turnstileSecretKey'])
        if (raw[k]) problems.push(`${k} must not be committed; use \`wrangler secret put\``);
    }
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  for (const p of problems) console.error(`${file}: ${p}`);
  if (problems.length) failed = true;
  else console.log(`${file}: ok`);
}
if (!files.length) console.log('no config files to validate');
process.exit(failed ? 1 : 0);
