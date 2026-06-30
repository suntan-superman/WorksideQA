const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/g,
  /sk_test_[A-Za-z0-9]+/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /SG\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
  /xox[baprs]-[A-Za-z0-9\-]+/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /(?<![A-Za-z0-9])\+?\d(?:[\s().-]*\d){9,}(?![A-Za-z0-9])/g,
  /\b(?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token)=([^&\s]+)/gi,
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}/g,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{24,}\b/g,
];

function maskSecrets(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskSecrets(item)]));
  }
  if (typeof value !== "string") return value;

  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[masked]");
  }
  return output;
}

function environmentSecretValues(env = process.env) {
  return Object.entries(env)
    .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|URL/i.test(key) && String(value || "").length >= 6)
    .map(([, value]) => String(value));
}

function sanitizeUrlQueries(value) {
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.search) parsed.search = "?[masked]";
      return parsed.toString();
    } catch {
      return "[masked-url]";
    }
  });
}

function sanitizeForAi(value, env = process.env) {
  let output = maskSecrets(value);
  if (typeof output === "object") output = JSON.stringify(output, null, 2);
  output = sanitizeUrlQueries(String(output));
  for (const secret of environmentSecretValues(env)) {
    output = output.split(secret).join("[masked]");
  }
  return maskSecrets(output);
}

module.exports = {
  maskSecrets,
  sanitizeForAi,
  SECRET_PATTERNS,
};
