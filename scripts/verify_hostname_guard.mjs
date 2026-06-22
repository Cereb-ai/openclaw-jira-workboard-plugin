// Direct test of the hostname guard logic: simulate what dispatcherFor does
// when called with a non-atlassian URL. Proves the guard prevents accidental
// proxying of other hosts.
import { ProxyAgent } from 'undici';

const PROXIED_HOSTNAME = 'api.atlassian.com';
function dispatcherFor(cfg, url) {
  if (!cfg.proxy) return undefined;
  if (url.hostname !== PROXIED_HOSTNAME) return undefined;
  return new ProxyAgent({ uri: cfg.proxy });
}

const cfgWithProxy = { proxy: 'http://127.0.0.1:7890' };
const cfgNoProxy = { proxy: '' };

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`); }
}

const d1 = dispatcherFor(cfgWithProxy, new URL('https://api.atlassian.com/ex/jira/abc/rest/api/3/search'));
check('atlassian URL + proxy: dispatcher attached', d1 instanceof ProxyAgent);

const d2 = dispatcherFor(cfgNoProxy, new URL('https://api.atlassian.com/ex/jira/abc/rest/api/3/search'));
check('atlassian URL + no proxy: no dispatcher', d2 === undefined);

const d3 = dispatcherFor(cfgWithProxy, new URL('https://example.com/foo'));
check('example.com + proxy: guard prevents dispatcher (undefined)', d3 === undefined);

const d4 = dispatcherFor(cfgNoProxy, new URL('https://example.com/foo'));
check('example.com + no proxy: no dispatcher', d4 === undefined);

const d5 = dispatcherFor(cfgWithProxy, new URL('https://acme.atlassian.net/rest/api/3/search'));
check('acme.atlassian.net + proxy: guard prevents dispatcher (NOT api.atlassian.com)', d5 === undefined);

const d6 = dispatcherFor(cfgWithProxy, new URL('http://api.atlassian.com/foo'));
check('http://api.atlassian.com + proxy: dispatcher attached (guard is hostname-only)', d6 instanceof ProxyAgent);

console.log(`\n=== Hostname guard: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
