const fs = require("fs");
const path = require("path");
const { fromRoot, log } = require("../../qa-utils/src");

const htmlDir = fromRoot("reports", "html");
const latest = fs.existsSync(htmlDir)
  ? fs
      .readdirSync(htmlDir)
      .filter((file) => file.endsWith(".html"))
      .map((file) => path.join(htmlDir, file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
  : null;

if (!latest) {
  log("No HTML reports found.");
  process.exit(1);
}

log(latest);

