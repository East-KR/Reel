/**
 * Build a single flow step object.
 * @param {string} action - One of: navigate, click, fill, select, wait, screenshot
 * @param {object} fields - Action-specific fields (selector, url, value, ms, path)
 * @returns {object} Step object
 */
function buildStep(action, fields = {}) {
  const step = { action, ...fields };
  if (!fields.description) {
    delete step.description;
  }
  return step;
}

/**
 * Extract all {{variable}} names from a steps array.
 * @param {object[]} steps
 * @returns {string[]} Unique variable names
 */
function extractVariables(steps) {
  const found = new Set();
  for (const step of steps) {
    for (const val of Object.values(step)) {
      if (typeof val === 'string') {
        for (const match of val.matchAll(/\{\{(\w+)\}\}/g)) {
          found.add(match[1]);
        }
      }
    }
  }
  return [...found];
}

/**
 * Build a complete flow object from steps.
 * @param {string} name - Flow name (kebab-case)
 * @param {string} domain - Hostname (e.g. "github.com")
 * @param {string} description - Human-readable description
 * @param {object[]} steps - Array of step objects
 * @returns {object} Flow JSON object
 */
function buildFlow(name, domain, description, steps) {
  const varNames = extractVariables(steps);
  const variables = {};
  for (const v of varNames) {
    variables[v] = { source: 'user', description: '' };
  }
  return { name, domain, description, version: 1, steps, variables };
}

module.exports = { buildStep, buildFlow, extractVariables };
