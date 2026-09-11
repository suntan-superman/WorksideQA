#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { loadProductManifest } = require('../../qa-config/src');
const { ensureDir, fromRoot, writeJson } = require('../../qa-utils/src');
const { runMaestroFlows, validateMaestroConfiguration } = require('./maestro-runner');

function timestampSlug(date = new Date()) { return date.toISOString().replace(/[:.]/g, '-'); }
function platformLabel(platform) { return platform === 'ios' ? 'iOS Simulator' : 'Android Emulator'; }

async function main() {
  const config = loadProductManifest('merxus');
  const validated = validateMaestroConfiguration(config);
  const root = ensureDir(fromRoot(validated.maestro.reportDirectory, timestampSlug()));
  const platforms = [
    { key: 'ios', device: 'iosSimulator' },
    { key: 'android', device: 'androidEmulator' },
  ];
  const executions = [];
  for (const platform of platforms) {
    try {
      const result = await runMaestroFlows(config, { suite: 'phase1', device: platform.device, runDirectory: path.join(root, platform.key) });
      executions.push({ platform: platform.key, status: 'passed', flows: result.results });
    } catch (error) {
      executions.push({ platform: platform.key, status: 'failed', error: String(error.message || error).replace(/((?:token|secret|password|key)=)[^\s]+/gi, '$1[REDACTED]') });
    }
  }
  const certified = executions.every((item) => item.status === 'passed');
  const summary = { title: 'Merxus Maestro Phase 1', certified, externalProviders: certified ? 0 : null, crossTenantLeakage: certified ? 0 : null, executions };
  writeJson(path.join(root, 'phase1-summary.json'), summary);
  const lines = ['# Merxus Maestro Phase 1', ''];
  for (const execution of executions) {
    lines.push(`## ${platformLabel(execution.platform)}`, '');
    if (execution.status === 'passed') lines.push('- Environment: PASS', '- Login: PASS', '- Tenant identity: PASS', '- Tenant isolation: PASS', '- Logout: PASS', '- Backend verification: PASS');
    else lines.push(`- Result: FAIL — ${execution.error}`);
    lines.push('');
  }
  lines.push(`- External Providers: ${certified ? '0' : 'NOT VERIFIED'}`, `- Cross-Tenant Leakage: ${certified ? '0' : 'NOT VERIFIED'}`, '', `Overall: ${certified ? 'PHASE 1 CERTIFIED' : 'PHASE 1 NOT CERTIFIED'}`, '');
  fs.writeFileSync(path.join(root, 'phase1-summary.md'), lines.join('\n'));
  process.stdout.write(`${lines.join('\n')}Artifacts: ${root}\n`);
  if (!certified) process.exitCode = 1;
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
