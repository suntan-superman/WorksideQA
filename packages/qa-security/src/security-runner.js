function check(status, name, message) {
  return { status, name, message };
}

async function runSecurityChecks(browserResult, config, options = {}) {
  const checks = [];

  if (options.dryRun) {
    checks.push(check("passed", "security dry run", "Would scan captured client-side signals for obvious secret exposure."));
    return { checks };
  }

  const consoleText = JSON.stringify(browserResult.consoleErrors || []);
  const exposed = /(sk_live_|sk_test_|AIza|TWILIO|OPENAI_API_KEY|FIREBASE_PRIVATE_KEY)/i.test(consoleText);
  checks.push(exposed ? check("failed", "secret exposure", "Potential secret-like value appeared in console output.") : check("passed", "secret exposure", "No obvious secret-like values captured in console output."));

  return { checks };
}

module.exports = {
  runSecurityChecks,
};

