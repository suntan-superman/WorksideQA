#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { loadProductManifest } = require('../../qa-config/src');
const { loadLocalQaConfig } = require('../../qa-core/src/local-config');
const { ensureDir, fromRoot, readJson, writeJson } = require('../../qa-utils/src');
const { runMaestroFlows, selectFlows, validateMaestroConfiguration } = require('./maestro-runner');
const { runAuthenticatedSmsIntegration } = require('./merxus-slice28-integration');

const COMPONENTS = Object.freeze([
  { key: 'interaction', label: 'A. iOS SMS settings interaction surface', suite: 'diagnostic-ios-text-input-focus-qahelper' },
  { key: 'persistence', label: 'B. SMS persistence integration', flow: '28-ios-owner-b-persistence' },
]);

function scrubError(error) {
  return String(error?.message || error || '').replace(/((?:token|secret|password|key)=)[^\s]+/gi, '$1[REDACTED]');
}

function backendEvidence(input) {
  const component = input && (Object.hasOwn(input, 'status') || Object.hasOwn(input, 'key')) ? input : null;
  const actualExecution = component ? component.execution : input;
  const result = actualExecution?.results?.[0];
  const backendStage = result?.stages?.backend?.status;
  const unavailableStatus = component?.status === 'failed' ? 'blocked' : 'not-run';
  if (!result || !actualExecution) {
    return {
      status: unavailableStatus,
      mutationContract: unavailableStatus,
      correlation: unavailableStatus,
      tenantIsolation: unavailableStatus,
      integrity: unavailableStatus,
      providerZero: unavailableStatus,
      requestId: null,
      operationId: null,
    };
  }
  if (backendStage !== 'passed') {
    const status = backendStage === 'failed' ? 'failed' : (component?.status === 'failed' ? 'blocked' : 'not-run');
    return {
      status,
      mutationContract: status,
      correlation: status,
      tenantIsolation: status,
      integrity: status,
      providerZero: status,
      requestId: null,
      operationId: null,
    };
  }
  const authoritative = result?.authoritativeResult || {};
  const contract = (key, predicate) => {
    if (!Object.hasOwn(authoritative, key)) return 'not-run';
    return predicate(authoritative[key]) ? 'passed' : 'failed';
  };
  const pairedContract = (keys, predicate) => {
    if (keys.some((key) => !Object.hasOwn(authoritative, key))) return 'not-run';
    return predicate(authoritative) ? 'passed' : 'failed';
  };
  const correlation = Object.hasOwn(authoritative, 'correlationMatched')
    ? (authoritative.correlationMatched === true ? 'passed' : 'failed')
    : pairedContract(['requestId', 'operationId'], (value) => Boolean(value.requestId && value.operationId));
  return {
    status: 'passed',
    mutationContract: contract('mutationExpected', (value) => value === true),
    correlation,
    tenantIsolation: pairedContract(['tenantAUnchanged', 'crossTenantLeakageCount'], (value) => value.tenantAUnchanged === true && value.crossTenantLeakageCount === 0),
    integrity: pairedContract(['revision', 'successAuditCount', 'operationReceiptCount'], (value) => value.revision === 2 && value.successAuditCount === 1 && value.operationReceiptCount === 1),
    providerZero: pairedContract(['externalProviderInvocationCount', 'blockedProviderAttemptCount'], (value) => value.externalProviderInvocationCount === 0 && value.blockedProviderAttemptCount === 0),
    mutationExpected: authoritative.mutationExpected,
    requestId: authoritative.requestId || null,
    operationId: authoritative.operationId || null,
  };
}

function evaluateComposite(components) {
  const interaction = components.find((component) => component.key === 'interaction');
  const persistence = components.find((component) => component.key === 'persistence');
  const backend = backendEvidence(persistence);
  const evidence = {
    interaction: interaction?.status === 'passed' ? 'passed' : 'failed',
    persistence: persistence?.status === 'passed' ? 'passed' : 'failed',
    backend: backend.status,
    mutationContract: backend.mutationContract,
    correlation: backend.correlation,
    tenantIsolation: backend.tenantIsolation,
    revisionAuditReceipt: backend.integrity,
    providerZero: backend.providerZero,
  };
  return { evidence, backend, certified: Object.values(evidence).every((status) => status === 'passed') };
}

async function runComponent(config, validated, component, options) {
  const directory = ensureDir(path.join(options.runDirectory, component.key));
  if (component.key === 'persistence') {
    const flow = selectFlows(validated, { flow: component.flow })[0];
    const generation = `${config.key}-maestro-${Date.now()}-${flow.name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    try {
      const integration = await runAuthenticatedSmsIntegration({ validated, flow, generation, runDirectory: directory });
      return {
        key: component.key,
        label: component.label,
        status: integration.status,
        execution: integration.execution,
        artifacts: integration.artifacts || directory,
        ...(integration.status === 'passed' ? {} : { stage: integration.failureStage || 'integration', reason: integration.reason || 'Authenticated persistence integration failed.' }),
      };
    } catch (error) {
      return {
        key: component.key,
        label: component.label,
        status: 'failed',
        artifacts: directory,
        stage: error.failureStage || 'integration',
        reason: scrubError(error),
      };
    }
  }
  try {
    const execution = await runMaestroFlows(config, {
      suite: component.suite,
      device: 'iosSimulator',
      runDirectory: directory,
    });
    const passed = execution.results.length > 0 && execution.results.every((result) => result.status === 'passed');
    const result = execution.results[0];
    return {
      key: component.key,
      label: component.label,
      status: passed ? 'passed' : 'failed',
      execution,
      artifacts: result?.artifacts || directory,
      ...(passed ? {} : { stage: result?.failureStage || 'ui', reason: result?.message || 'Component failed.' }),
    };
  } catch (error) {
    const configuredFlow = selectFlows(validated, { suite: component.suite })[0];
    const resultPath = path.join(directory, configuredFlow.name, 'result.json');
    let recorded = null;
    if (fs.existsSync(resultPath)) {
      try { recorded = readJson(resultPath); } catch { recorded = null; }
    }
    return {
      key: component.key,
      label: component.label,
      status: 'failed',
      artifacts: recorded?.artifacts || directory,
      stage: recorded?.failureStage || 'ui',
      reason: recorded?.message || scrubError(error),
      ...(recorded ? { execution: { results: [recorded] } } : {}),
    };
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
    components: components.map(({ key, label, status, artifacts, stage, reason }) => ({ key, label, status, artifacts, ...(stage ? { stage } : {}), ...(reason ? { reason } : {}) })),
    evidence,
    backend,
    artifacts: runDirectory,
  };
  writeJson(path.join(runDirectory, 'slice28-composite-summary.json'), summary);
  console.log('\n============================================================');
  console.log('Merxus Maestro Slice 28 iOS Composite Certification');
  console.log('============================================================');
  const render = (status) => status.toUpperCase();
  console.log(`${COMPONENTS[0].label.padEnd(36)}${render(evidence.interaction)}`);
  console.log(`${COMPONENTS[1].label.padEnd(36)}${render(evidence.persistence)}`);
  console.log(`C. Backend authoritative verification ${render(evidence.backend)}`);
  console.log(`D. Tenant isolation                    ${render(evidence.tenantIsolation)}`);
  console.log(`E. Revision/audit/receipt              ${render(evidence.revisionAuditReceipt)}`);
  console.log(`F. Provider-zero                       ${render(evidence.providerZero)}`);
  console.log(`\n${certified ? 'SLICE 28 CERTIFIED' : 'SLICE 28 NOT CERTIFIED'}`);
  console.log(`Artifacts: ${runDirectory}`);
  if (!certified) process.exitCode = 1;
  return summary;
}

function validateComposite(config) {
  const validated = validateMaestroConfiguration(config);
  for (const component of COMPONENTS) {
    const selected = component.flow ? selectFlows(validated, { flow: component.flow }) : selectFlows(validated, { suite: component.suite });
    if (selected.length !== 1) throw new Error(`Slice 28 component ${component.key} must select exactly one flow.`);
  }
  const interaction = selectFlows(validated, { suite: COMPONENTS[0].suite })[0];
  const persistence = selectFlows(validated, { flow: COMPONENTS[1].flow })[0];
  if (interaction.mutationExpected !== false || interaction.backendVerification) throw new Error('Slice 28 interaction component must be a read-only diagnostic without backend verification.');
  if (persistence.mutationExpected !== true || persistence.backendVerification !== 'phase2-settings-owner-b-isolation' || !persistence.iosIntegration) throw new Error('Slice 28 persistence component must require the authenticated integration and protected backend verification.');
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
