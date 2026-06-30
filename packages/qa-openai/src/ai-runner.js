const fs = require("fs");
const path = require("path");
const { fromRoot } = require("../../qa-utils/src");

function check(status, name, message) {
  return { status, name, message };
}

function openAiApiKey() {
  return process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
}

async function createResponse({ model, input }) {
  const apiKey = openAiApiKey();
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input,
      reasoning: { effort: "low" },
      max_output_tokens: 700,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message || `OpenAI API returned ${response.status}`);
  }

  return body;
}

function outputText(response) {
  if (response.output_text) return response.output_text;
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .filter(Boolean)
    .join("\n");
}

async function runAiChecks(config, options = {}) {
  const promptDir = fromRoot("prompts");
  const personas = config.personas || [];

  if (options.dryRun) {
    return { checks: [check("passed", "ai dry run", `Would evaluate ${personas.length} persona prompt(s).`)] };
  }

  if (!config.ai?.enabled) {
    return { checks: [check("skipped", "ai personas", "AI persona testing is not enabled for this product.")] };
  }

  const missing = personas.filter((persona) => !fs.existsSync(path.join(promptDir, `${persona}.md`)));
  if (missing.length > 0) {
    return { checks: [check("warning", "ai persona prompts", `Missing prompt files: ${missing.join(", ")}.`)] };
  }

  if (!openAiApiKey()) {
    return { checks: [check("skipped", "ai conversation evaluation", "Prompt library is present. Set OPENAI_API_KEY or OPENAI_KEY to run credential-gated live evaluations.")] };
  }

  const testCases = config.ai.testCases || [];
  if (testCases.length === 0) {
    return { checks: [check("skipped", "ai conversation evaluation", "No ai.testCases are configured for this product.")] };
  }

  const checks = [];
  const model = config.ai.model || process.env.WORKSIDEQA_OPENAI_MODEL || "gpt-5.4-mini";
  for (const testCase of testCases) {
    try {
      const response = await createResponse({
        model,
        input: [
          {
            role: "developer",
            content: "You are evaluating a Workside product AI workflow. Return a compact QA judgment with PASS or FAIL, intent, grounding risk, safety risk, and next action.",
          },
          {
            role: "user",
            content: `Product: ${config.name}\nPersona: ${testCase.persona}\nScenario: ${testCase.scenario}\nExpected intent: ${testCase.expectedIntent}`,
          },
        ],
      });
      const text = outputText(response);
      checks.push(/FAIL/i.test(text) ? check("warning", `ai ${testCase.name}`, text) : check("passed", `ai ${testCase.name}`, text));
    } catch (error) {
      checks.push(check("failed", `ai ${testCase.name}`, error.message));
    }
  }

  return { checks };
}

module.exports = {
  createResponse,
  openAiApiKey,
  runAiChecks,
};
