const { validateFlow } = require('../src/utils/validator');

const validFlow = {
  name: 'test',
  domain: 'example.com',
  description: '',
  version: 1,
  steps: [
    { action: 'navigate', url: 'https://example.com' },
    { action: 'fill', selector: '#q', value: '{{query}}' }
  ],
  variables: {
    query: { source: 'user', description: '' }
  }
};

describe('validateFlow', () => {
  test('returns ok for a valid flow', () => {
    const result = validateFlow(validFlow);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('errors on empty steps', () => {
    const flow = { ...validFlow, steps: [] };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Flow must have at least one step.');
  });

  test('errors on undefined variable in step', () => {
    const flow = {
      ...validFlow,
      steps: [{ action: 'fill', selector: '#q', value: '{{undeclared}}' }],
      variables: {}
    };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/undeclared/);
  });

  test('errors on missing flow name', () => {
    const flow = { ...validFlow, name: '' };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Flow name is required.');
  });

  test('errors on missing domain', () => {
    const flow = { ...validFlow, domain: '' };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Flow domain is required.');
  });

  test('accumulates multiple errors', () => {
    const flow = { ...validFlow, name: '', domain: '' };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toContain('Flow name is required.');
    expect(result.errors).toContain('Flow domain is required.');
  });

  test('errors on step missing action field', () => {
    const flow = {
      ...validFlow,
      steps: [{ selector: '#btn' }],
      variables: {}
    };
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Each step must have an action field.');
  });
});
