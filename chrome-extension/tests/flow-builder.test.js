const { buildStep, buildFlow } = require('../src/utils/flow-builder');

describe('buildStep', () => {
  test('builds a click step', () => {
    const step = buildStep('click', { selector: '#btn' });
    expect(step).toEqual({ action: 'click', selector: '#btn' });
  });

  test('builds a fill step with static value', () => {
    const step = buildStep('fill', { selector: '#input', value: 'hello' });
    expect(step).toEqual({ action: 'fill', selector: '#input', value: 'hello' });
  });

  test('builds a fill step with variable value', () => {
    const step = buildStep('fill', { selector: '#input', value: '{{name}}' });
    expect(step).toEqual({ action: 'fill', selector: '#input', value: '{{name}}' });
  });

  test('builds a navigate step', () => {
    const step = buildStep('navigate', { url: 'https://example.com' });
    expect(step).toEqual({ action: 'navigate', url: 'https://example.com' });
  });

  test('includes optional description when provided', () => {
    const step = buildStep('click', { selector: '#btn', description: 'Submit' });
    expect(step.description).toBe('Submit');
  });

  test('omits description when not provided', () => {
    const step = buildStep('click', { selector: '#btn' });
    expect(step.description).toBeUndefined();
  });

  test('handles missing fields argument', () => {
    const step = buildStep('screenshot');
    expect(step).toEqual({ action: 'screenshot' });
  });
});

describe('buildFlow', () => {
  const steps = [
    { action: 'navigate', url: 'https://example.com' },
    { action: 'fill', selector: '#q', value: '{{query}}' }
  ];

  test('builds a valid flow object', () => {
    const flow = buildFlow('my-search', 'example.com', 'Search for something', steps);
    expect(flow.name).toBe('my-search');
    expect(flow.domain).toBe('example.com');
    expect(flow.description).toBe('Search for something');
    expect(flow.version).toBe(1);
    expect(flow.steps).toEqual(steps);
  });

  test('extracts variables from steps', () => {
    const flow = buildFlow('my-search', 'example.com', '', steps);
    expect(flow.variables).toHaveProperty('query');
    expect(flow.variables.query).toEqual({ source: 'user', description: '' });
  });

  test('returns empty variables when no {{}} found', () => {
    const staticSteps = [{ action: 'click', selector: '#btn' }];
    const flow = buildFlow('test', 'example.com', '', staticSteps);
    expect(flow.variables).toEqual({});
  });

  test('extracts multiple variables from different steps', () => {
    const multiVarSteps = [
      { action: 'navigate', url: 'https://example.com/{{owner}}/{{repo}}' },
      { action: 'fill', selector: '#title', value: '{{title}}' }
    ];
    const flow = buildFlow('multi', 'example.com', '', multiVarSteps);
    expect(Object.keys(flow.variables)).toHaveLength(3);
    expect(flow.variables).toHaveProperty('owner');
    expect(flow.variables).toHaveProperty('repo');
    expect(flow.variables).toHaveProperty('title');
  });
});
