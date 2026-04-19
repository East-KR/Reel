// Flow Recorder content script
// Phase 1: hover highlight + click/fill/navigate recording

if (window.__flowRecorderLoaded) throw new Error('already loaded');
window.__flowRecorderLoaded = true;

let recording = false;
let highlighted = null;
let fillDebounceTimer = null;
let pendingFillTarget = null; // tracked for flush-on-navigate
let lastVariableTarget = null;

const HIGHLIGHT_STYLE = '2px solid #4A90E2';
const HIGHLIGHT_ATTR = 'data-flow-recorder-highlight';
const FILL_DEBOUNCE_MS = 500;

function highlight(el) {
  if (highlighted && highlighted !== el) {
    clearHighlight(highlighted);
  }
  if (el && !el.hasAttribute(HIGHLIGHT_ATTR)) {
    el.dataset.flowRecorderPrevOutline = el.style.outline;
    el.style.outline = HIGHLIGHT_STYLE;
    el.setAttribute(HIGHLIGHT_ATTR, '');
    highlighted = el;
  }
}

function clearHighlight(el) {
  if (!el) return;
  el.style.outline = el.dataset.flowRecorderPrevOutline || '';
  delete el.dataset.flowRecorderPrevOutline;
  el.removeAttribute(HIGHLIGHT_ATTR);
  if (highlighted === el) highlighted = null;
}

// Returns true if `id` is a framework-generated dynamic ID (unstable across reloads).
// Covers React useId (:r2:, :R1357rn7ptkq:), Radix-style, and similar patterns.
function isDynamicId(id) {
  // React useId always starts and ends with ':'
  if (id.startsWith(':') && id.endsWith(':')) return true;
  // Any id that contains only hex/alphanumeric with 8+ chars after a separator (e.g. radix-abc12345)
  if (/[-_][a-f0-9]{8,}$/i.test(id)) return true;
  return false;
}

function getCssSelector(el) {
  // Walk up to nearest Element if given a text node or other non-element node
  while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentElement;
  if (!el) return '';

  // Returns true if `sel` matches exactly this element and nothing else
  function isUnique(sel, target) {
    try {
      const r = document.querySelectorAll(sel);
      return r.length === 1 && r[0] === target;
    } catch (_) { return false; }
  }

  const tag = el.tagName.toLowerCase();

  // 1. Unique id — skip dynamic/framework-generated IDs
  if (el.id && !isDynamicId(el.id)) {
    const s = '#' + CSS.escape(el.id);
    if (isUnique(s, el)) return s;
  }

  // 2. Stable semantic / data attributes (order matters — most reliable first)
  for (const attr of ['data-testid', 'data-id', 'data-cy', 'data-test', 'aria-label', 'name']) {
    const val = el.getAttribute(attr);
    if (!val) continue;
    const s = `${tag}[${attr}="${CSS.escape(val)}"]`;
    if (isUnique(s, el)) return s;
  }

  // 3. Class combinations — stable classes (no CSS-module hash) first, hashes as fallback
  if (el.classList.length > 0) {
    const classes = [...el.classList];
    const stable = classes.filter(c => !/___\w+$/.test(c));
    const ordered = [...stable, ...classes.filter(c => /___\w+$/.test(c))];
    for (let n = 1; n <= ordered.length; n++) {
      const s = tag + ordered.slice(0, n).map(c => '.' + CSS.escape(c)).join('');
      if (isUnique(s, el)) return s;
    }
  }

  // 4. Build shortest unique ancestor-rooted path.
  //    Walk up until we hit an id-bearing ancestor or <body>.
  const chain = [];
  let cur = el;
  while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
    chain.unshift(cur);
    if (cur !== el && cur.id && !isDynamicId(cur.id)) break; // strong anchor — stop here
    cur = cur.parentElement;
  }

  // Per-node segment: prefer classes, fall back to nth-child only when needed
  function segment(node) {
    if (!node || !node.tagName) return '';
    if (node.id && !isDynamicId(node.id)) return '#' + CSS.escape(node.id);
    const t = node.tagName.toLowerCase();
    const parent = node.parentElement;
    const classes = [...node.classList];
    const stable = classes.filter(c => !/___\w+$/.test(c));
    const useClasses = (stable.length > 0 ? stable : classes).slice(0, 3);

    if (useClasses.length > 0) {
      const base = t + useClasses.map(c => '.' + CSS.escape(c)).join('');
      // If multiple siblings share the same tag+class, add positional hint
      if (parent) {
        try {
          const sibs = parent.querySelectorAll(`:scope > ${base}`);
          if (sibs.length > 1) {
            const idx = [...parent.children].indexOf(node) + 1;
            return `${t}:nth-child(${idx})`;
          }
        } catch (_) {}
      }
      return base;
    }

    // No classes: positional only
    if (parent) {
      const sameTags = [...parent.children].filter(c => c.tagName === node.tagName);
      if (sameTags.length > 1) {
        const idx = [...parent.children].indexOf(node) + 1;
        return `${t}:nth-child(${idx})`;
      }
    }
    return t;
  }

  // Try increasingly longer paths: start with just the element, add ancestors until unique
  for (let start = chain.length - 1; start >= 0; start--) {
    const sel = chain.slice(start).map(segment).join(' > ');
    if (isUnique(sel, el)) return sel;
  }

  // Last resort: full chain (guaranteed to be at least as specific as before)
  return chain.map(segment).join(' > ');
}

function sendStep(step) {
  chrome.runtime.sendMessage({ type: 'RECORD_STEP', step })
    .catch(() => {}); // background service worker may be inactive
}

function onMouseOver(e) {
  if (!recording) return;
  highlight(e.target);
}

function onMouseOut(e) {
  if (!recording) return;
  // relatedTarget is null when pointer leaves viewport — contains(null) returns false, which is correct
  if (e.target.contains(e.relatedTarget)) return;
  clearHighlight(e.target);
}

function onClickRecord(e) {
  if (!recording) return;
  const selector = getCssSelector(e.target);
  if (!selector) return; // discard clicks on non-identifiable elements
  sendStep({ action: 'click', selector, locator: getLocator(e.target) });
}

function getPendingValue(target) {
  return target.isContentEditable ? (target.innerText || '') : (target.value || '');
}

function flushPendingFill() {
  if (!fillDebounceTimer || !pendingFillTarget) return;
  clearTimeout(fillDebounceTimer);
  fillDebounceTimer = null;
  sendStep({
    action: 'fill',
    selector: getCssSelector(pendingFillTarget),
    locator: getLocator(pendingFillTarget),
    value: getPendingValue(pendingFillTarget),
  });
  pendingFillTarget = null;
}

function onInputRecord(e) {
  if (!recording) return;
  const target = e.target;

  if (target.tagName === 'SELECT') {
    sendStep({ action: 'select', selector: getCssSelector(target), locator: getLocator(target), value: target.value });
    return;
  }

  // Record INPUT, TEXTAREA, and contenteditable elements (e.g. rich text mail body)
  const isEditable = ['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable;
  if (!isEditable) return;

  pendingFillTarget = target;
  clearTimeout(fillDebounceTimer);
  fillDebounceTimer = setTimeout(() => {
    sendStep({
      action: 'fill',
      selector: getCssSelector(target),
      locator: getLocator(target),
      value: getPendingValue(target),
    });
    fillDebounceTimer = null;
    pendingFillTarget = null;
  }, FILL_DEBOUNCE_MS);
}

function onKeyDownRecord(e) {
  // Flush fill immediately when Enter is pressed (prevents loss on form submit/navigation)
  if (recording && e.key === 'Enter') flushPendingFill();
}

function onFormSubmit() {
  if (recording) flushPendingFill();
}

function onContextMenu(e) {
  const target = e.target;
  if (target instanceof Element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
    lastVariableTarget = target;
  } else {
    lastVariableTarget = null;
  }
}

function cleanup() {
  recording = false;
  clearTimeout(fillDebounceTimer);
  pendingFillTarget = null;
  lastVariableTarget = null;
  if (highlighted) clearHighlight(highlighted);
  document.removeEventListener('mouseover', onMouseOver);
  document.removeEventListener('mouseout', onMouseOut);
  document.removeEventListener('click', onClickRecord);
  document.removeEventListener('input', onInputRecord);
  document.removeEventListener('keydown', onKeyDownRecord);
  document.removeEventListener('submit', onFormSubmit);
  document.removeEventListener('contextmenu', onContextMenu, true);
}

// On page load, check if recording is already active and record this navigation.
// Navigate steps are only meaningful for top-level frames — iframe loads (ads,
// widgets, etc.) must not be recorded as navigation steps.
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
  if (chrome.runtime.lastError || !res) return;
  if (res.recording) {
    recording = true;
    if (window === window.top) {
      sendStep({ action: 'navigate', url: window.location.href });
    }
  }
});

// --- DOM scanner helpers (used by scan_page action) ---

function resolveLabel(el) {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  if (el.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lbl) return lbl.textContent.trim();
  }
  const parentLabel = el.closest('label');
  if (parentLabel) return parentLabel.textContent.trim();
  const labelledById = el.getAttribute('aria-labelledby');
  if (labelledById) {
    const lbl = document.getElementById(labelledById);
    if (lbl) return lbl.textContent.trim();
  }
  return null;
}

function isHiddenEl(el) {
  if (el.disabled || el.hidden) return true;
  const style = window.getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
}

function isAriaHiddenEl(el) {
  let cur = el;
  while (cur && cur !== document.body) {
    if (cur.getAttribute('aria-hidden') === 'true') return true;
    cur = cur.parentElement;
  }
  return false;
}

// Build a multi-strategy locator for stable element resolution at playback time.
function getLocator(el) {
  const css = getCssSelector(el);
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') || tag;
  const label = resolveLabel(el);
  const isInteractive = tag === 'button' || tag === 'a' || el.hasAttribute('role');
  const text = isInteractive
    ? (el.textContent || '').trim().slice(0, 80) || null
    : null;
  return { css, text, role, label };
}

// Listen for recording state from background/popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    recording = true;
    // Only top-level frame records the initial navigate step
    if (window === window.top) {
      sendStep({ action: 'navigate', url: window.location.href });
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'STOP_RECORDING') {
    flushPendingFill();
    recording = false;
    clearTimeout(fillDebounceTimer);
    if (highlighted) clearHighlight(highlighted);
    sendResponse({ ok: true });
  } else if (msg.type === 'CLEANUP') {
    cleanup();
    sendResponse({ ok: true });
  } else if (msg.type === 'MARK_AS_VARIABLE') {
    if (!lastVariableTarget) {
      sendResponse({ ok: false, error: 'No editable target selected' });
      return true;
    }
    const selector = getCssSelector(lastVariableTarget);
    const varName = prompt('Variable name (without {{ }}):');
    if (!varName) {
      sendResponse({ ok: false, error: 'Cancelled' });
      return true;
    }
    const trimmed = varName.trim();
    if (!/^[A-Za-z_]\w*$/.test(trimmed)) {
      sendResponse({ ok: false, error: 'Variable names must use letters, numbers, and underscores only' });
      return true;
    }
    chrome.runtime.sendMessage({
      type: 'MARK_VARIABLE_FOR_SELECTOR',
      selector,
      variableName: trimmed
    }, (result) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse(result || { ok: false, error: 'No response from recorder' });
    });
    return true;
  } else if (msg.type === 'EXECUTE_CMD') {
    const { action, selector, value, url, script, ms, locator } = msg.cmd;
    void (async () => {
      try {
        let result;

        // Resolve an element using CSS selector first, then locator fallbacks.
        // Accepts old flows (selector string only) and new flows (selector + locator).
        async function resolveElement(sel, loc, timeoutMs = 8000) {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            // 1. CSS selector
            if (sel) {
              const el = document.querySelector(sel);
              if (el) return el;
            }
            if (loc) {
              // 2. aria-label exact match
              if (loc.label) {
                try {
                  const el = document.querySelector(`[aria-label="${CSS.escape(loc.label)}"]`);
                  if (el) return el;
                } catch (_) {}
              }
              // 3. role + text exact match
              if (loc.text) {
                const textNorm = loc.text.trim();
                const roleSel = loc.role === 'button'
                  ? 'button, [role="button"]'
                  : loc.role === 'a' || loc.role === 'link'
                  ? 'a, [role="link"]'
                  : loc.role ? `${loc.role}, [role="${CSS.escape(loc.role)}"]` : 'button, a, [role]';
                try {
                  for (const c of document.querySelectorAll(roleSel)) {
                    if ((c.textContent || '').trim() === textNorm) return c;
                  }
                } catch (_) {}
              }
            }
            await new Promise(r => setTimeout(r, 100));
          }
          throw new Error(`Element not found: ${sel || JSON.stringify(loc)}`);
        }

        if (action === 'click') {
          const el = await resolveElement(selector, locator);
          el.click();
        } else if (action === 'fill') {
          const el = await resolveElement(selector, locator);
          el.focus();

          // Select all existing content first, then insert — works for both
          // contenteditable (rich text editors) and regular input/textarea.
          // execCommand('insertText') fires real beforeinput/input events that
          // custom frameworks (Naver Mail, etc.) rely on, unlike direct value writes.
          if (el.isContentEditable) {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, value);
          } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.select();
            const inserted = document.execCommand('insertText', false, value);
            if (!inserted || el.value !== value) {
              // execCommand blocked (e.g. sandboxed context) — fall back to native setter
              const proto = el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (nativeSetter) nativeSetter.call(el, value); else el.value = value;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: value }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else {
            // Unknown element type — best effort
            el.textContent = value;
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          }
        } else if (action === 'select') {
          const el = await resolveElement(selector, locator);
          if (!(el instanceof HTMLSelectElement)) throw new Error(`Element is not a <select>: ${selector}`);
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (action === 'waitForSelector') {
          const timeoutMs = typeof ms === 'number' ? ms : 10000;
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeoutMs) {
            if (selector && document.querySelector(selector)) {
              result = 'true';
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (result !== 'true') throw new Error(`Timed out waiting for selector: ${selector}`);
        } else if (action === 'navigate') {
          sendResponse({ ok: true });
          setTimeout(() => {
            window.location.href = url;
          }, 0);
          return;
        } else if (action === 'evaluate') {
          // eslint-disable-next-line no-eval
          result = await Promise.resolve(eval(script)); // safe: only reachable via localhost bridge
        } else if (action === 'scan_page') {
          const SELECTORS = [
            'input:not([type="hidden"])',
            'textarea',
            '[contenteditable="true"]',
            'select',
            'button',
            '[role="button"]',
            'input[type="submit"]',
            'input[type="button"]',
            'a[href]',
            '[role="tab"]',
            '[role="menuitem"]',
            '[role="option"]',
          ];

          const seen = new Set();
          const elements = [];

          for (const sel of SELECTORS) {
            for (const el of document.querySelectorAll(sel)) {
              if (seen.has(el)) continue;
              seen.add(el);
              if (isHiddenEl(el) || isAriaHiddenEl(el)) continue;
              const selectorStr = getCssSelector(el);
              if (!selectorStr) continue;

              const tag = el.tagName.toLowerCase();
              const hasRole = el.hasAttribute('role');
              const loc = getLocator(el);
              elements.push({
                tag,
                type: el.getAttribute('type') || null,
                selector: selectorStr,
                locator: loc,
                label: loc.label,
                placeholder: el.placeholder || null,
                text: (tag === 'button' || tag === 'a' || hasRole)
                  ? (el.textContent || '').trim().slice(0, 80) || null
                  : null,
                href: el instanceof HTMLAnchorElement ? el.href || null : null,
                name: el.getAttribute('name') || null,
                required: el.required || false,
                options: tag === 'select'
                  ? [...el.options].map(o => ({ value: o.value, text: o.text.trim() }))
                  : null,
              });
            }
          }

          sendResponse({ ok: true, url: window.location.href, title: document.title, elements });
          return; // skip generic sendResponse below
        } else {
          throw new Error(`Unknown action: ${action}`);
        }
        sendResponse({ ok: true, result: result !== undefined ? String(result) : undefined });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // keep channel open for async
  }
});

document.addEventListener('mouseover', onMouseOver);
document.addEventListener('mouseout', onMouseOut);
document.addEventListener('click', onClickRecord);
document.addEventListener('input', onInputRecord);
document.addEventListener('keydown', onKeyDownRecord);
document.addEventListener('submit', onFormSubmit);
document.addEventListener('contextmenu', onContextMenu, true);
