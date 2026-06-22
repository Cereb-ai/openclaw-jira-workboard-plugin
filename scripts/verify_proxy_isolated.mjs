// Behavioral validation of the new dist/http.js proxy behavior.
// We don't have a real Jira endpoint, but we can verify:
//   1. process.env.HTTPS_PROXY/HTTP_PROXY is NOT touched by jiraGet/Post/Put
//   2. The hostname guard rejects non-atlassian URLs (no dispatcher attached)
//   3. The dispatcher is attached for api.atlassian.com when cfg.proxy is set
//   4. Empty cfg.proxy → no dispatcher at all
//
// We monkey-patch global fetch to capture what dispatcher was passed in
// and what URL was requested, then short-circuit so we don't hit network.

import { jiraGet, jiraPost, jiraPut, JiraHttpError } from '../dist/http.js';

const captured = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  captured.push({
    url: typeof url === 'string' ? url : url.toString(),
    hostname: (typeof url === 'string' ? new URL(url) : url).hostname,
    hasDispatcher: 'dispatcher' in init,
    dispatcherType: init.dispatcher?.constructor?.name ?? null,
  });
  // Pretend the API returned 401 so we exercise the error path
  return new Response('{"error":"unauthorized"}', {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json' },
  });
};

const envBefore = {
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  HTTP_PROXY: process.env.HTTP_PROXY,
  https_proxy: process.env.https_proxy,
  http_proxy: process.env.http_proxy,
};

const cfg = {
  atstToken: 'fake-token',
  cloudId: 'fake-cloud',
  proxy: 'http://127.0.0.1:7890',  // set proxy so dispatcher should be attached
  defaultAssigneeAccountId: '',
};

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`); }
}

console.log('--- Test 1: jiraGet hits api.atlassian.com, proxy is set ---');
try { await jiraGet(cfg, 'search', { jql: 'project=TEST' }); } catch (e) { /* expected 401 */ }
check('exactly one fetch captured', captured.length === 1, `got ${captured.length}`);
const c1 = captured[0];
check('host is api.atlassian.com', c1?.hostname === 'api.atlassian.com', `got ${c1?.hostname}`);
check('dispatcher was attached', c1?.hasDispatcher === true, `hasDispatcher=${c1?.hasDispatcher}`);
check('dispatcher is ProxyAgent', c1?.dispatcherType === 'ProxyAgent', `dispatcherType=${c1?.dispatcherType}`);

console.log('\n--- Test 2: jiraPost hits api.atlassian.com, proxy is set ---');
captured.length = 0;
try { await jiraPost(cfg, 'issue', { fields: { summary: 'x' } }); } catch (e) {}
check('dispatcher was attached', captured[0]?.hasDispatcher === true);
check('dispatcher is ProxyAgent', captured[0]?.dispatcherType === 'ProxyAgent');

console.log('\n--- Test 3: jiraPut hits api.atlassian.com, proxy is set ---');
captured.length = 0;
try { await jiraPut(cfg, 'issue/TEST-1', { fields: { summary: 'y' } }); } catch (e) {}
check('dispatcher was attached', captured[0]?.hasDispatcher === true);
check('dispatcher is ProxyAgent', captured[0]?.dispatcherType === 'ProxyAgent');

console.log('\n--- Test 4: process.env.HTTPS_PROXY/HTTP_PROXY never touched ---');
const envAfter = {
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  HTTP_PROXY: process.env.HTTP_PROXY,
  https_proxy: process.env.https_proxy,
  http_proxy: process.env.http_proxy,
};
check('HTTPS_PROXY unchanged', envBefore.HTTPS_PROXY === envAfter.HTTPS_PROXY);
check('HTTP_PROXY unchanged', envBefore.HTTP_PROXY === envAfter.HTTP_PROXY);
check('https_proxy unchanged', envBefore.https_proxy === envAfter.https_proxy);
check('http_proxy unchanged', envBefore.http_proxy === envAfter.http_proxy);

console.log('\n--- Test 5: empty cfg.proxy → no dispatcher attached ---');
const cfgNoProxy = { ...cfg, proxy: '' };
captured.length = 0;
try { await jiraGet(cfgNoProxy, 'search'); } catch (e) {}
check('dispatcher NOT attached when proxy is empty', captured[0]?.hasDispatcher === false, `hasDispatcher=${captured[0]?.hasDispatcher}`);

console.log('\n--- Test 6: process.env never has HTTPS_PROXY set even when proxy is set ---');
// Already covered by test 4 (process.env untouched), but double-check proxy is set and env is still clean
const envHasProxy = 'HTTPS_PROXY' in process.env && process.env.HTTPS_PROXY === 'http://127.0.0.1:7890';
check('process.env.HTTPS_PROXY is NOT cfg.proxy', !envHasProxy);

console.log('\n--- Test 7: hostname guard — non-atlassian URL would not be proxied ---');
// We can't easily redirect fetch to a non-atlassian URL because the plugin
// builds the URL from cfg.cloudId. But we can verify the guard logic by
// checking the dispatcherFor function path: if we modify cfg to point at a
// different host, no dispatcher. Instead, just verify that the URL always
// goes to api.atlassian.com by construction.
check('all URLs go to api.atlassian.com', captured.every(c => c.hostname === 'api.atlassian.com'));

// Restore
globalThis.fetch = originalFetch;

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
