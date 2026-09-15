#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { loadProductManifest } = require('../../qa-config/src');
const { loadLocalQaConfig } = require('../../qa-core/src/local-config');
const { ensureDir, fromRoot, writeJson } = require('../../qa-utils/src');
const { runMaestroFlows, selectFlows, validateMaestroConfiguration } = require('./maestro-runner');

const COMPONENTS = Object.freeze([
  { key: 'interaction', label: 'A. Real TextInput interaction', suite: 'diagnostic-ios-text-input-focus-qahelper' },
  { key: 'persistence', label: 'B. Save/Reload persistence', suite: 'phase2-owner-b-isolation-ios-persistence' },
]);

function scrubError(error) {
  return String(error?.message || error || '').replace(/((?:token|secret|password|key)=)[^\s]+/gi, '$1[REDACTED]');
}

function backendEvidence(execution) {
  const result = execution?.results?.[0];
  const authoritative = result?.authoritativeResult || {};
  const backendPassed = result?.stages?.backend?.status === 'passed';
  return {
    status: backendPassed ? 'passed' : 'failed',
    mutationExpected: authoritative.mutationExpected === true,
    tenantIsolation: authoritative.tenantAUnchanged === true && authoritative.crossTenantLeakageCount === 0,
    integrity: authoritative.revision === 2 && authoritative.successAuditCount === 1 && authoritative.operationReceiptCount === 1,
    providerZero: authoritative.externalProviderInvocationCount === 0 && authoritative.blockedProviderAttemptCount === 0,
    requestId: authoritative.requestId || null,
    operationId: authoritative.operationId || null,
  };
}

function evaluateComposite(components) {
  const interaction = components.find((component) => component.key === 'interaction');
  const persistence = components.find((component) => component.key === 'persistence');
  const backend = backendEvidence(persistence?.execution);
  const evidence = {
    interaction: interaction?.status === 'passed' ? 'passed' : 'failed',
    persistence: persistence?.status === 'passed' ? 'passed' : 'failed',
    backend: backend.status,
    mutationContract: backend.mutationExpected ? 'passed' : 'failed',
    correlation: backend.requestId && backend.operationId ? 'passed' : 'failed',
    tenantIsolation: backend.tenantIsolation ? 'passed' : 'failed',
    revisionAuditReceipt: backend.integrity ? 'passed' : 'failed',
    providerZero: backend.providerZero ? 'passed' : 'failed',
  };
  return { evidence, backend, certified: Object.values(evidence).every((status) => status === 'passed') };
}

async function runComponent(config, validated, component, options) {
  const directory = ensureDir(path.join(options.runDirectory, component.key));
  try {
    const execution = await runMaestroFlows(config, {
      suite: component.suite,
      device: 'iosSimulator',
      runDirectory: directory,
    });
    const passed = execution.results.length > 0 && execution.results.every((result) => result.status === 'passed');
    return { key: component.key, label: component.label, status: passed ? 'passed' : 'failed', execution };
  } catch (error) {
    return { key: component.key, label: component.label, status: 'failed', error: scrubError(error) };
  }
}

async function runComposite(config, options = {}) {
  const validated = validateMaestroConfiguration(config);
  const runDirectory = options.runDirectory || fromRoot(validated.maestro.reportDirectory, 'slice28-composite', new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(runDirectory);
  const components = [];
  for (const component of COMPONENTS) components.push(await runComponent(config, validated, component, { runDirectory }));
  const { evidence, backend, certified } = evaluateComposite(components);
  const summary = {
    title: 'Merxus Maestro Slice 28 iOS Composite Certification',
    certified,
    components: components.map(({ key, label, status, error }) => ({ key, label, status, ...(error ? { error } : {}) })),
    evidence,
    backend,
    artifacts: runDirectory,
  };
  writeJson(path.join(runDirectory, 'slice28-composite-summary.json'), summary);
  console.log('\n============================================================');
  console.log('Merxus Maestro Slice 28 iOS Composite Certification');
  console.log('============================================================');
  console.log(`${COMPONENTS[0].label.padEnd(36)}${evidence.interaction.toUpperCase()}`);
  console.log(`${COMPONENTS[1].label.padEnd(36)}${evidence.persistence.toUpperCase()}`);
  console.log(`C. Backend authoritative verification${evidence.backend === 'passed' ? ' PASS' : ' FAIL'}`);
  console.log(`D. Tenant isolation${evidence.tenantIsolation === 'passed' ? ' PASS' : ' FAIL'}`);
  console.log(`E. Revision/audit/receipt${evidence.revisionAuditReceipt === 'passed' ? ' PASS' : ' FAIL'}`);
  console.log(`F. Provider-zero${evidence.providerZero === 'passed' ? ' PASS' : ' FAIL'}`);
  console.log(`\n${certified ? 'SLICE 28 CERTIFIED' : 'SLICE 28 NOT CERTIFIED'}`);
  console.log(`Artifacts: ${runDirectory}`);
  if (!certified) process.exitCode = 1;
  return summary;
}

function validateComposite(config) {
  const validated = validateMaestroConfiguration(config);
  for (const component of COMPONENTS) {
    const selected = selectFlows(validated, { suite: component.suite });
    if (selected.length !== 1) throw new Error(`Slice 28 component ${component.key} must select exactly one flow.`);
  }
  const interaction = selectFlows(validated, { suite: COMPONENTS[0].suite })[0];
  const persistence = selectFlows(validated, { suite: COMPONENTS[1].suite })[0];
  if (interaction.mutationExpected !== false || interaction.backendVerification) throw new Error('Slice 28 interaction component must be a read-only diagnostic without backend verification.');
  if (persistence.mutationExpected !== true || !persistence.backendVerification) throw new Error('Slice 28 persistence component must require the protected backend verification.');
  return { validated, interaction, persistence };
}

async function main() {
  const validateOnly = process.argv.includes('--validate');
  loadLocalQaConfig({ required: true });
  const config = loadProductManifest('merxus');
  validateComposite(config);
  if (validateOnly) {
    console.log('Validated Slice 28 iOS composite certification: interaction + persistence + backend verification');
    return;
  }
  await runComposite(config);
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });

module.exports = { COMPONENTS, backendEvidence, evaluateComposite, runComposite, validateComposite };
