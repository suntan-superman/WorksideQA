const { loadEnvFile } = require("./manifest");

const REQUIRED_BY_PRODUCT = {
  radiusiq: ["RADIUSIQ_DEMO_EMAIL", "RADIUSIQ_DEMO_PASSWORD"],
  merxus: ["MERXUS_DEMO_EMAIL", "MERXUS_DEMO_PASSWORD"],
  sageset: ["SAGESET_DEMO_EMAIL", "SAGESET_DEMO_PASSWORD"],
  "support-console": ["SUPPORT_CONSOLE_DEMO_EMAIL", "SUPPORT_CONSOLE_DEMO_PASSWORD"],
  "route-logistics": ["ROUTE_LOGISTICS_DEMO_EMAIL", "ROUTE_LOGISTICS_DEMO_PASSWORD"],
  anyryde: ["ANYRYDE_DEMO_EMAIL", "ANYRYDE_DEMO_PASSWORD"],
};

const OPTIONAL_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_KEY",
  "RADIUSIQ_API_HEALTH_URL",
  "MERXUS_API_HEALTH_URL",
  "SAGESET_API_HEALTH_URL",
  "SUPPORT_CONSOLE_API_HEALTH_URL",
  "ROUTE_LOGISTICS_API_HEALTH_URL",
  "ANYRYDE_API_HEALTH_URL",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "FIREBASE_ACCESS_TOKEN",
  "SAGESET_PUSH_TEST_TOKEN",
  "ROUTE_LOGISTICS_PUSH_TEST_TOKEN",
  "ANYRYDE_PUSH_TEST_TOKEN",
];

function statusForKey(key) {
  return process.env[key] ? "set" : "missing";
}

function envStatus() {
  loadEnvFile();
  return {
    products: Object.fromEntries(
      Object.entries(REQUIRED_BY_PRODUCT).map(([product, keys]) => [
        product,
        Object.fromEntries(keys.map((key) => [key, statusForKey(key)])),
      ])
    ),
    optional: Object.fromEntries(OPTIONAL_KEYS.map((key) => [key, statusForKey(key)])),
  };
}

module.exports = {
  envStatus,
  OPTIONAL_KEYS,
  REQUIRED_BY_PRODUCT,
};

