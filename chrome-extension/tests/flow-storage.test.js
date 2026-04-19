const { flowList, flowRead, flowSave, flowDelete } = require('../src/utils/flow-storage');

let store = {};

beforeEach(() => {
  store = {};
  global.chrome = {
    storage: {
      local: {
        get: jest.fn(async (key) => ({ [key]: store[key] })),
        set: jest.fn(async (obj) => { Object.assign(store, obj); }),
      }
    }
  };
});

const FLOW = {
  name: 'login', domain: 'example.com', description: 'Login flow',
  version: 1, steps: [], variables: {}
};

describe('flowSave', () => {
  test('returns ok:true', async () => {
    const result = await flowSave('example.com', 'login', FLOW);
    expect(result).toEqual({ ok: true });
  });

  test('persists the flow under domain/name', async () => {
    await flowSave('example.com', 'login', FLOW);
    expect(store.flows['example.com']['login']).toEqual(FLOW);
  });

  test('overwrites an existing flow with the same name', async () => {
    await flowSave('example.com', 'login', FLOW);
    const updated = { ...FLOW, description: 'Updated' };
    await flowSave('example.com', 'login', updated);
    expect(store.flows['example.com']['login'].description).toBe('Updated');
  });
});

describe('flowRead', () => {
  test('returns ok:true and the flow when it exists', async () => {
    await flowSave('example.com', 'login', FLOW);
    const result = await flowRead('example.com', 'login');
    expect(result).toEqual({ ok: true, flow: FLOW });
  });

  test('returns ok:false with error when flow does not exist', async () => {
    const result = await flowRead('example.com', 'missing');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  test('returns ok:false when domain does not exist', async () => {
    const result = await flowRead('no-domain.com', 'login');
    expect(result.ok).toBe(false);
  });
});

describe('flowList', () => {
  test('returns ok:true with empty flows when storage is empty', async () => {
    const result = await flowList();
    expect(result).toEqual({ ok: true, flows: {} });
  });

  test('returns domain-grouped summaries (name, description, variables only)', async () => {
    await flowSave('example.com', 'login', FLOW);
    const result = await flowList();
    expect(result.ok).toBe(true);
    expect(result.flows['example.com']).toHaveLength(1);
    expect(result.flows['example.com'][0]).toEqual({
      name: 'login',
      description: 'Login flow',
      variables: {}
    });
    expect(result.flows['example.com'][0].steps).toBeUndefined();
  });

  test('groups multiple flows by domain', async () => {
    const FLOW2 = { ...FLOW, name: 'search', domain: 'example.com' };
    await flowSave('example.com', 'login', FLOW);
    await flowSave('example.com', 'search', FLOW2);
    const result = await flowList();
    expect(result.flows['example.com']).toHaveLength(2);
  });
});

describe('flowDelete', () => {
  test('removes a flow and returns ok:true', async () => {
    await flowSave('example.com', 'login', FLOW);
    const result = await flowDelete('example.com', 'login');
    expect(result).toEqual({ ok: true });
    expect((await flowRead('example.com', 'login')).ok).toBe(false);
  });

  test('removes the domain key when its last flow is deleted', async () => {
    await flowSave('example.com', 'login', FLOW);
    await flowDelete('example.com', 'login');
    expect(store.flows['example.com']).toBeUndefined();
  });

  test('is idempotent when the flow does not exist', async () => {
    const result = await flowDelete('example.com', 'ghost');
    expect(result).toEqual({ ok: true });
  });
});
