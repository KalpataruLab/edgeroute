// Fails when forbidden identifiers would be committed or are already tracked.
//   node scripts/check-forbidden.mts            staged changes (pre-commit)
//   node scripts/check-forbidden.mts --all      every tracked file (CI)
//   node scripts/check-forbidden.mts --message <file>   a commit message (commit-msg)
// The patterns are assembled from pieces so this file does not contain the words it forbids.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const ORG = ['as', 'abd'].join('');
const ABBR = ['A', 'S', 'A'].join('');
const RULES: [string, RegExp][] = [
  [`"${ORG}" (any case)`, new RegExp(ORG, 'i')],
  // Capitals, whole word ("data" and "ASAP" do not match). Written without backslashes on purpose.
  [`the word "${ABBR}"`, new RegExp(`(^|[^A-Za-z0-9_])${ABBR}($|[^A-Za-z0-9_])`)]
];

function scan(label: string, text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of RULES) if (re.test(line)) hits.push(`${label}:${i + 1}: contains ${name}`);
  });
  return hits;
}

const args = process.argv.slice(2);
let problems: string[] = [];

if (args[0] === '--message') {
  problems = scan('commit message', readFileSync(args[1] ?? '', 'utf8'));
} else if (args[0] === '--all') {
  for (const f of git('ls-files', '-z').split('\0').filter(Boolean)) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('\0')) problems.push(...scan(f, text));
  }
} else {
  // Staged content only: the lines being added, so old history never blocks an unrelated commit.
  for (const line of git('diff', '--cached', '-U0', '--no-color').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++'))
      problems.push(...scan('staged diff', line.slice(1)).map(p => `${p}  ${line.slice(1, 80)}`));
  }
  const email = git('config', 'user.email').trim();
  if (RULES[0]![1].test(email))
    problems.push(`git user.email is an employer address; run: git config --local user.email <noreply address>`);
}

if (problems.length) {
  console.error(`Forbidden identifiers found:\n${problems.map(p => `  ${p}`).join('\n')}`);
  console.error('Use neutral values (example.test, 203.0.113.x) and keep real logs in git-ignored folders.');
  process.exit(1);
}
