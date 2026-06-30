const { readJson } = require("./files");
const { fromRoot } = require("./paths");

function platformVersion() {
  return readJson(fromRoot("package.json")).version;
}

module.exports = {
  platformVersion,
};
