function validateSageSetMetroManifest(manifest, expectedAppId = 'com.workside.sageset') {
  const expoClient = manifest?.extra?.expoClient;
  if (!expoClient || typeof expoClient !== 'object') throw new Error('SageSet Metro manifest has no expoClient configuration.');
  const appId = String(expoClient.android?.package || '').trim();
  if (appId !== expectedAppId) throw new Error(`SageSet Metro served Android package ${appId || '(missing)'}; expected ${expectedAppId}.`);
  const extra = expoClient.extra || {};
  if (String(extra.appEnvironment || '').trim().toLowerCase() !== 'maestro') throw new Error(`SageSet Metro served appEnvironment ${extra.appEnvironment || '(missing)'}; expected maestro.`);
  const maestro = extra.maestro;
  if (!maestro || maestro.enabled !== true) throw new Error('SageSet Metro Maestro runtime marker is missing or disabled.');
  if (String(maestro.firebaseProjectId || '').trim() !== 'sageset-maestro-local') throw new Error(`SageSet Metro served Firebase project ${maestro.firebaseProjectId || '(missing)'}; expected sageset-maestro-local.`);
  if (String(maestro.emulatorHost || '').trim() !== '10.0.2.2') throw new Error(`SageSet Metro served emulator host ${maestro.emulatorHost || '(missing)'}; expected 10.0.2.2.`);
  if (maestro.externalNotificationsAllowed !== false) throw new Error('SageSet Metro external notifications are not disabled.');
  return {
    appId,
    environment: 'maestro',
    firebaseProjectId: 'sageset-maestro-local',
    emulatorHost: '10.0.2.2',
    externalNotificationsAllowed: false,
  };
}

module.exports = { validateSageSetMetroManifest };
