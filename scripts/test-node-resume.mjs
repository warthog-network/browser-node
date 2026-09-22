/**
 * Reload resumes the node that was on, and auto-update can be turned off.
 *
 * Run: npm run test:resume
 */
const { autoReloadFromStored } = await import('../src/lib/clientVersion.js');
const { shouldAutoResume } = await import('../src/lib/nodeNetworks.js');

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

check('missing auto-update preference stays on', autoReloadFromStored(null) === true);
check('empty auto-update preference stays on', autoReloadFromStored('') === true);
check('stored 1 keeps auto-update on', autoReloadFromStored('1') === true);
check('stored 0 turns auto-update off', autoReloadFromStored('0') === false);
check('stored false turns auto-update off', autoReloadFromStored('false') === false);

const base = {
  remembered: 'defi',
  networkId: 'defi',
  canStart: true,
  resetDb: false,
  opfsReset: false,
  lockedRecently: false,
};
check('running DeFi node resumes after reload', shouldAutoResume(base) === true);
check('stopped node does not resume', shouldAutoResume({ ...base, remembered: null }) === false);
check('other network does not resume', shouldAutoResume({ ...base, networkId: 'official1' }) === false);
check('Start not allowed does not resume', shouldAutoResume({ ...base, canStart: false }) === false);
check('resetDb reload does not resume', shouldAutoResume({ ...base, resetDb: true }) === false);
check('OPFS reset does not resume', shouldAutoResume({ ...base, opfsReset: true }) === false);
check('resume already started this load does not start twice', shouldAutoResume({ ...base, lockedRecently: true }) === false);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nnode resume ok');
