const { extractVariables } = require('./flow-builder');

function validateFlow(flow) {
  const errors = [];

  if (!flow.name || flow.name.trim() === '') {
    errors.push('Flow name is required.');
  }

  if (!flow.domain || flow.domain.trim() === '') {
    errors.push('Flow domain is required.');
  }

  if (!flow.steps || flow.steps.length === 0) {
    errors.push('Flow must have at least one step.');
  } else {
    for (const step of flow.steps) {
      if (!step.action) {
        errors.push('Each step must have an action field.');
      }
    }
    const usedVars = extractVariables(flow.steps);
    const declaredVars = Object.keys(flow.variables || {});
    for (const v of usedVars) {
      if (!declaredVars.includes(v)) {
        errors.push(`Variable "{{${v}}}" used in steps but not declared in variables.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateFlow };
