const path = require("path");
const { fileExists, readJson, fromRoot } = require("../../qa-utils/src");

const REQUIRED_FIELDS = ["key", "name", "type", "status", "baseUrl", "suites"];

function productManifestPath(productKey) {
  return fromRoot("products", productKey, "product.manifest.json");
}

function listProductKeys() {
  const fs = require("fs");
  const productsRoot = fromRoot("products");
  if (!fileExists(productsRoot)) return [];

  return fs
    .readdirSync(productsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((key) => fileExists(productManifestPath(key)))
    .sort();
}

function validateManifest(manifest) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === "") {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (manifest.key && !/^[a-z0-9-]+$/.test(manifest.key)) {
    errors.push("key must use lowercase letters, numbers, and hyphens only");
  }

  if (!manifest.baseUrl || typeof manifest.baseUrl !== "object" || !manifest.baseUrl.local) {
    errors.push("baseUrl.local is required");
  }

  if (!manifest.suites || typeof manifest.suites !== "object" || !Array.isArray(manifest.suites.smoke)) {
    errors.push("suites.smoke must be an array");
  }

  if (manifest.devServer?.enabled) {
    for (const field of ["workingDirectory", "command", "port", "healthUrl"]) {
      if (!manifest.devServer[field]) errors.push(`devServer.${field} is required when devServer.enabled is true`);
    }
  }

  if (errors.length > 0) {
    const error = new Error(`Invalid manifest for ${manifest.key || "unknown product"}: ${errors.join("; ")}`);
    error.validationErrors = errors;
    throw error;
  }

  return manifest;
}

function loadProductManifest(productKey) {
  const manifestPath = productManifestPath(productKey);
  if (!fileExists(manifestPath)) {
    throw new Error(`Product manifest not found: ${path.relative(fromRoot(), manifestPath)}`);
  }

  const manifest = readJson(manifestPath);
  if (manifest.key !== productKey) {
    throw new Error(`Manifest key mismatch: expected ${productKey}, found ${manifest.key}`);
  }

  return validateManifest(manifest);
}

function resolveProductConfig(manifest, environment = "local") {
  const baseUrl = manifest.baseUrl[environment] || manifest.baseUrl.local;
  return {
    ...manifest,
    environment,
    resolvedBaseUrl: baseUrl,
  };
}

function loadEnvFile(filePath = fromRoot(".env.local"), options = {}) {
  const fs = require("fs");
  if (!fileExists(filePath)) return {};
  const override = options.override !== false;

  const entries = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    entries[key] = value.replace(/^["']|["']$/g, "");
    if (override || process.env[key] === undefined) process.env[key] = entries[key];
  }

  return entries;
}

module.exports = {
  listProductKeys,
  loadEnvFile,
  loadProductManifest,
  productManifestPath,
  resolveProductConfig,
  validateManifest,
};
