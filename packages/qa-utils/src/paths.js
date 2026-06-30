const path = require("path");

function repoRoot() {
  return path.resolve(__dirname, "../../..");
}

function fromRoot(...parts) {
  return path.join(repoRoot(), ...parts);
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/");
}

module.exports = {
  repoRoot,
  fromRoot,
  toPosixPath,
};

