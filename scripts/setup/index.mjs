// Postprovision setup: idempotent, safe to re-run.
//   node scripts/setup/index.mjs                  # everything
//   node scripts/setup/index.mjs --only users     # users | sharepoint | search
//   node scripts/setup/index.mjs --skip-tap       # don't (re)issue Temporary Access Passes
import { loadAzdEnv, log, c, env } from './lib/util.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const want = (step) => !only || only === step;

loadAzdEnv();

if (env('SKIP_SETUP', 'false') === 'true') {
  log.warn('SKIP_SETUP=true: skipping SharePoint/Search setup.');
  process.exit(0);
}

const { ensureUsers } = await import('./steps/users.mjs');
const { setupSharePoint } = await import('./steps/sharepoint.mjs');
const { setupSearch } = await import('./steps/search.mjs');

try {
  if (want('users')) await ensureUsers({ issueTaps: !args.includes('--skip-tap') && env('DEMO_ISSUE_TAP', 'true') === 'true' });
  if (want('sharepoint')) await setupSharePoint();
  if (want('search')) await setupSearch({ runAndWait: !args.includes('--no-run') });

  console.log(`\n${c.bold(c.green('Setup complete.'))}`);
  console.log(`  Web app:     ${env('WEB_URL', '(run azd deploy)')}`);
  console.log(`  Personas:    ${['ALICE', 'BOB', 'CAROL'].map((p) => env(`PERSONA_${p}_UPN`, '?')).join(', ')}`);
  console.log(`  Sign-in:     see .azure/${env('AZURE_ENV_NAME', '')}/demo-credentials.txt`);
} catch (e) {
  log.err(e.stack ?? e.message);
  if (e.cause) log.err(`cause: ${e.cause.code ?? ''} ${e.cause.message ?? e.cause}`);
  process.exit(1);
}
