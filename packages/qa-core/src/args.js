function parseArgs(argv) {
  const options = {
    all: false,
    suite: "smoke",
    environment: process.env.WORKSIDEQA_ENVIRONMENT || "local",
    headless: process.env.WORKSIDEQA_HEADLESS !== "false",
    dryRun: false,
    startServer: false,
    aiReview: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") options.all = true;
    else if (arg === "--product") options.product = argv[++index];
    else if (arg === "--suite") options.suite = argv[++index];
    else if (arg === "--environment" || arg === "--env") options.environment = argv[++index];
    else if (arg === "--headed") options.headless = false;
    else if (arg === "--headless") options.headless = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--start-server") options.startServer = true;
    else if (arg === "--ai-review") options.aiReview = true;
    else if (arg === "--update-baselines") options.updateBaselines = true;
    else if (arg === "--timeout") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function helpText() {
  return `WorksideQA

Usage:
  npm run qa -- --product radiusiq --suite smoke
  npm run qa -- --all --suite smoke

Options:
  --product <key>       Product key from products/<key>/product.manifest.json
  --all                 Run the suite for every product manifest
  --suite <name>        Suite name, defaults to smoke
  --environment <name>  local, staging, or production; defaults to local
  --headed              Run browser visibly
  --dry-run             Validate orchestration without launching apps
  --start-server        Start configured local dev server before browser checks
  --update-baselines    Create missing visual regression baselines from current screenshots
  --ai-review           Generate credential-gated AI release review output
`;
}

module.exports = {
  helpText,
  parseArgs,
};
