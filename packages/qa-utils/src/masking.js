const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/g,
  /sk_test_[A-Za-z0-9]+/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /SG\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
  /xox[baprs]-[A-Za-z0-9\-]+/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /(?<![A-Za-z0-9])\+?\d(?:[\s().-]*\d){9,}(?![A-Za-z0-9])/g,
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

module.exports = {
  maskSecrets,
  SECRET_PATTERNS,
};
