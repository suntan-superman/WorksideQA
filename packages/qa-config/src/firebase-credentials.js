const fs = require("fs");
const path = require("path");

const DEFAULT_FIREBASE_CREDENTIALS_DIR = "C:/Users/sjroy/Source/WorksideSecrets/firebase";

function firebaseCredentialsDir() {
  return process.env.WORKSIDEQA_FIREBASE_CREDENTIALS_DIR || DEFAULT_FIREBASE_CREDENTIALS_DIR;
}

function firebaseCredentialFile(config = {}) {
  const configuredFile = config.firebase?.credentialFile;
  const candidates = [
    configuredFile,
    config.key ? `${config.key}.json` : null,
    config.firebase?.projectId ? `${config.firebase.projectId}.json` : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const filePath = path.isAbsolute(candidate) ? candidate : path.join(firebaseCredentialsDir(), candidate);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function hasFirebaseCredential(config = {}) {
  return Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.FIREBASE_ACCESS_TOKEN ||
      firebaseCredentialFile(config)
  );
}

function loadProductServiceAccount(config = {}) {
  const filePath = firebaseCredentialFile(config);
  if (!filePath) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

module.exports = {
  DEFAULT_FIREBASE_CREDENTIALS_DIR,
  firebaseCredentialFile,
  firebaseCredentialsDir,
  hasFirebaseCredential,
  loadProductServiceAccount,
};
