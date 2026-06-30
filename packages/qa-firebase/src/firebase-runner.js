const crypto = require("crypto");
const fs = require("fs");

function check(status, name, message) {
  return { status, name, message };
}

function credentialSource() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return "json";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return "application-default";
  if (process.env.FIREBASE_ACCESS_TOKEN) return "access-token";
  return null;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
  }

  return null;
}

async function getAccessToken() {
  if (process.env.FIREBASE_ACCESS_TOKEN) return process.env.FIREBASE_ACCESS_TOKEN;

  const serviceAccount = loadServiceAccount();
  if (!serviceAccount?.client_email || !serviceAccount?.private_key) {
    throw new Error("Service account JSON must include client_email and private_key.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.private_key, "base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const assertion = `${unsigned}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error_description || body.error || `OAuth token request failed with ${response.status}`);
  return body.access_token;
}

async function fetchFirestoreDocument(projectId, documentPath, accessToken) {
  const encodedPath = documentPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encodedPath}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Firestore returned ${response.status}`);
  return body;
}

async function runFirestoreDocumentCheck(projectId, accessToken, item) {
  const document = await fetchFirestoreDocument(projectId, item.path, accessToken);
  if (!document) {
    return check(item.required === false ? "warning" : "failed", `firestore ${item.name}`, `Document not found: ${item.path}`);
  }

  const fields = document.fields || {};
  const missingFields = (item.requiredFields || []).filter((field) => fields[field] === undefined || fields[field] === null);
  if (missingFields.length > 0) {
    return check("failed", `firestore ${item.name}`, `Missing required field(s): ${missingFields.join(", ")}.`);
  }

  return check("passed", `firestore ${item.name}`, `Verified document: ${item.path}`);
}

async function runFirebaseChecks(config, options = {}) {
  if (options.dryRun) {
    return { checks: [check("passed", "firebase dry run", "Would run configured read-only Firebase checks.")] };
  }

  if (!config.firebase?.enabled) {
    return { checks: [check("skipped", "firebase", "Firebase is not enabled for this product.")] };
  }

  const checks = [];
  const readOnlyChecks = config.firebase.readOnlyChecks || [];
  if (readOnlyChecks.length === 0) {
    checks.push(check("skipped", "firebase read-only verification", `Firebase project ${config.firebase.projectId || "unknown"} is registered; no readOnlyChecks configured.`));
    return { checks };
  }

  if (!credentialSource()) {
    checks.push(check("skipped", "firebase credentials", "Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS to run read-only Firebase checks."));
    return { checks };
  }

  try {
    const accessToken = await getAccessToken();
    for (const item of readOnlyChecks) {
      if (item.type === "firestoreDocument") {
        checks.push(await runFirestoreDocumentCheck(config.firebase.projectId, accessToken, item));
      } else {
        checks.push(check("warning", `firebase ${item.name || item.type}`, `Unsupported read-only Firebase check type: ${item.type}`));
      }
    }
  } catch (error) {
    checks.push(check("failed", "firebase read-only verification", error.message));
  }

  return { checks };
}

module.exports = {
  credentialSource,
  fetchFirestoreDocument,
  getAccessToken,
  runFirebaseChecks,
};
