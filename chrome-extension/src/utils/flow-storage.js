async function flowList() {
  const { flows } = await chrome.storage.local.get('flows');
  const data = flows || {};
  const result = {};
  for (const [domain, byName] of Object.entries(data)) {
    result[domain] = Object.values(byName).map(({ name, description, variables }) => ({
      name,
      description: description || '',
      variables: variables || {},
    }));
  }
  return { ok: true, flows: result };
}

async function flowRead(domain, name) {
  const { flows } = await chrome.storage.local.get('flows');
  const flow = (flows || {})[domain]?.[name];
  if (!flow) return { ok: false, error: `Flow not found: ${domain}/${name}` };
  return { ok: true, flow };
}

async function flowSave(domain, name, flow) {
  const { flows } = await chrome.storage.local.get('flows');
  const data = flows || {};
  if (!data[domain]) data[domain] = {};
  data[domain][name] = flow;
  await chrome.storage.local.set({ flows: data });
  return { ok: true };
}

async function flowDelete(domain, name) {
  const { flows } = await chrome.storage.local.get('flows');
  const data = flows || {};
  if (data[domain]) {
    delete data[domain][name];
    if (Object.keys(data[domain]).length === 0) delete data[domain];
  }
  await chrome.storage.local.set({ flows: data });
  return { ok: true };
}

async function varsSave(domain, name, vars) {
  const { varValues } = await chrome.storage.local.get('varValues');
  const data = varValues || {};
  data[`${domain}/${name}`] = vars;
  await chrome.storage.local.set({ varValues: data });
  return { ok: true };
}

async function varsLoad(domain, name) {
  const { varValues } = await chrome.storage.local.get('varValues');
  const vars = (varValues || {})[`${domain}/${name}`] || {};
  return { ok: true, vars };
}

if (typeof module !== 'undefined') {
  module.exports = { flowList, flowRead, flowSave, flowDelete, varsSave, varsLoad };
}
