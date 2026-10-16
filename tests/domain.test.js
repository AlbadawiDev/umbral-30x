import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, DomainError, parseMoney, formatMoney, createState, addInvoices, processInvoices, updatePolicy, approveInvoice, rejectInvoice, getMetrics, getLatestDecision } from '../src/domain.js';

const CTX = { actor: 'Daniel · demo', now: '2026-10-16T23:00:00.000Z' };
const REVIEW = { ...CTX, note: 'Comprobé el acuerdo y el importe con la documentación ficticia.' };
function policy(changes = {}) { return { ...structuredClone(DEFAULT_POLICY), ...changes }; }
function invoice(id = 'one', changes = {}) {
  return { id, number: `INV-${id}`, beneficiaryId: 'norte', beneficiaryName: 'Norte Studio (ficticio)', amount: '100.00', currency: 'USD', dueDate: '2026-10-25', agreementId: 'DES-01', description: 'Diseño de interfaz ficticio', sourceText: '', extractionIssues: [], ...changes };
}
function processed(rows, configuration = DEFAULT_POLICY) { return processInvoices(addInvoices(createState(configuration), rows, CTX), CTX); }
function status(state, id) { return getLatestDecision(state, id)?.status; }

test('money is exact decimal text, including 0.1 + 0.2', () => {
  assert.equal(parseMoney('0.1') + parseMoney('0.2'), 30);
  assert.equal(parseMoney('0.01'), 1);
  assert.equal(parseMoney('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(formatMoney(123456), 'USD 1234.56');
  assert.equal(formatMoney(-1), '-USD 0.01');
  for (const invalid of [0.1, NaN, '1e2', ' 1.00', '1,00', '-1', '01', '.20', '1.001', 'Infinity', '90071992547409.92']) assert.throws(() => parseMoney(invalid), DomainError);
});

test('normal invoice reserves once and every operation is immutable', () => {
  const source = createState(); const snapshot = JSON.stringify(source);
  const added = addInvoices(source, [invoice()], CTX);
  assert.equal(JSON.stringify(source), snapshot);
  assert.equal(added.revision, 1);
  const before = JSON.stringify(added); const result = processInvoices(added, CTX);
  assert.equal(JSON.stringify(added), before);
  assert.equal(result.revision, 2);
  assert.equal(status(result, 'one'), 'PAY');
  assert.deepEqual(getMetrics(result), { total: 1, pending: 0, pay: 1, block: 0, review: 0, reservedMinor: 10000, reservedPeriodMinor: 10000, remainingBudgetMinor: 340000, remainingBalanceMinor: 290000, autonomyPercent: 100, policyPeriod: '2026-10' });
  assert.strictEqual(processInvoices(result, CTX), result);
  assert.strictEqual(addInvoices(result, [invoice()], CTX), result);
  assert.strictEqual(approveInvoice(result, 'one', REVIEW), result);
  assert.equal(result.decisions.length, 1);
});

test('business duplicate with another import ID cannot reserve twice', () => {
  const result = processed([invoice('a', { number: 'N-2026' }), invoice('b', { number: ' n-2026 ' })]);
  assert.equal(status(result, 'a'), 'PAY'); assert.equal(status(result, 'b'), 'BLOCK');
  assert.equal(getMetrics(result).reservedMinor, 10000);
  assert.equal(getLatestDecision(result, 'b').checks.find(check => check.ruleId === 'duplicate').passed, false);
});

test('invisible, directional, Unicode-space and confusable invoice identifiers never authorize another payment', () => {
  for (const altered of ['INV-2026-\u200b1', 'INV-2026-\u20601', 'INV-2026-\u202e1', 'INV-2026-\u00a01', 'INV-2026-\n1', 'ＩＮＶ-2026-1']) {
    let result = processed([invoice('a', { number: 'INV-2026-1' }), invoice('b', { number: altered })]);
    const expected = altered === 'ＩＮＶ-2026-1' ? 'BLOCK' : 'REVIEW';
    assert.equal(status(result, 'a'), 'PAY'); assert.equal(status(result, 'b'), expected, JSON.stringify(altered));
    if (expected === 'REVIEW') result = approveInvoice(result, 'b', REVIEW);
    else assert.throws(() => approveInvoice(result, 'b', REVIEW), { code: 'REVIEW_REQUIRED' });
    assert.equal(status(result, 'b'), expected); assert.equal(getMetrics(result).reservedMinor, 10000);
    assert.equal(getLatestDecision(result, 'b').checks.find(check => check.ruleId === 'invoice-number').passed, false);
  }
});

test('same invoice number with a different authorized beneficiary is not a duplicate', () => {
  const result = processed([invoice('a', { number: 'COMMON' }), invoice('b', { number: 'COMMON', beneficiaryId: 'brisa', beneficiaryName: 'Brisa Contenido', agreementId: 'COPY-01' })]);
  assert.equal(status(result, 'a'), 'PAY'); assert.equal(status(result, 'b'), 'PAY');
  assert.equal(getMetrics(result).reservedMinor, 20000);
});

test('unknown beneficiary and missing or ambiguous inputs fail closed into review', () => {
  const rows = [invoice('unknown', { beneficiaryId: 'intruso' }), invoice('missing', { amount: '' }), invoice('ambiguous', { extractionIssues: ['Dos importes posibles: 50 y 500.'] }), invoice('name', { beneficiaryName: 'Beneficiario distinto' }), invoice('float', { amount: 0.3 }), invoice('zero', { amount: '0' }), invoice('nocontract', { agreementId: '' })];
  const result = processed(rows);
  for (const row of rows) assert.equal(status(result, row.id), 'REVIEW', row.id);
  assert.equal(getMetrics(result).reservedMinor, 0);
});

test('agreement mismatch, disabled supplier, cross-currency and absolute limits block', () => {
  const configuration = policy(); configuration.beneficiaries[3].enabled = false;
  const rows = [invoice('wrong', { agreementId: 'CLOUD-01' }), invoice('agreementcap', { amount: '700.01' }), invoice('absolute', { amount: '2000.01' }), invoice('huge', { amount: '9999999999999.99' }), invoice('currency', { currency: 'EUR' }), invoice('disabled', { beneficiaryId: 'oriente', beneficiaryName: 'Taller Oriente', agreementId: 'OPS-01' })];
  const result = processed(rows, configuration);
  for (const row of rows) assert.equal(status(result, row.id), 'BLOCK', row.id);
  assert.equal(getMetrics(result).reservedMinor, 0);
  assert.throws(() => approveInvoice(result, 'wrong', REVIEW), { code: 'REVIEW_REQUIRED' });
});

test('automatic threshold is inclusive and does not reserve the human-review invoice', () => {
  const result = processed([invoice('threshold', { amount: '500.00' }), invoice('review', { amount: '500.01' })]);
  assert.equal(status(result, 'threshold'), 'PAY'); assert.equal(status(result, 'review'), 'REVIEW');
  assert.equal(getMetrics(result).reservedMinor, 50000);
});

test('sequential reservations honor the exact remaining balance', () => {
  const result = processed([invoice('a', { amount: '0.10' }), invoice('b', { amount: '0.20' }), invoice('c', { amount: '0.01' })], policy({ availableBalance: '0.30' }));
  assert.equal(status(result, 'a'), 'PAY'); assert.equal(status(result, 'b'), 'PAY'); assert.equal(status(result, 'c'), 'BLOCK');
  assert.equal(getMetrics(result).remainingBalanceMinor, 0); assert.equal(getMetrics(result).reservedMinor, 30);
});

test('period budget independently blocks even when balance remains', () => {
  const result = processed([invoice('a', { amount: '300.00' }), invoice('b', { amount: '300.00' })], policy({ periodBudget: '500.00', availableBalance: '3000.00' }));
  assert.equal(status(result, 'a'), 'PAY'); assert.equal(status(result, 'b'), 'BLOCK');
  assert.equal(getLatestDecision(result, 'b').checks.find(check => check.ruleId === 'budget').passed, false);
  assert.equal(getLatestDecision(result, 'b').checks.find(check => check.ruleId === 'balance').passed, true);
});

test('human approval requires a meaningful note and keeps complete decision history', () => {
  const before = processed([invoice('a', { amount: '600.00' })]);
  for (const note of ['', 'ok', 'aprobado aprobado']) assert.throws(() => approveInvoice(before, 'a', { ...CTX, ...(note ? { note } : {}) }), { code: 'NOTE_REQUIRED' });
  const result = approveInvoice(before, 'a', REVIEW);
  assert.equal(status(result, 'a'), 'PAY'); assert.equal(result.decisions.length, 2); assert.equal(result.decisions[0].status, 'REVIEW');
  assert.equal(getLatestDecision(result, 'a').mode, 'human'); assert.equal(getLatestDecision(result, 'a').note, REVIEW.note);
  assert.equal(result.audit.at(-1).note, REVIEW.note); assert.equal(getMetrics(result).reservedMinor, 60000);
  assert.equal(status(before, 'a'), 'REVIEW'); assert.equal(getMetrics(before).reservedMinor, 0);
});

test('human approval cannot clear missing, ambiguous or unknown input by writing a note', () => {
  const before = processed([invoice('a', { extractionIssues: ['Fecha ambigua.'] }), invoice('b', { beneficiaryId: 'desconocido' }), invoice('c', { amount: '' })]);
  let result = before;
  for (const id of ['a', 'b', 'c']) { result = approveInvoice(result, id, REVIEW); assert.equal(status(result, id), 'REVIEW'); }
  assert.equal(getMetrics(result).reservedMinor, 0);
  assert.strictEqual(approveInvoice(result, 'c', REVIEW), result);
});

test('two human reviews recheck reservations rather than approving a stale balance', () => {
  let result = processed([invoice('a', { amount: '600.00' }), invoice('b', { amount: '600.00', beneficiaryId: 'andina', beneficiaryName: 'Andina Cloud', agreementId: 'CLOUD-01' })], policy({ availableBalance: '1000.00' }));
  assert.equal(status(result, 'a'), 'REVIEW'); assert.equal(status(result, 'b'), 'REVIEW');
  result = approveInvoice(result, 'a', REVIEW); result = approveInvoice(result, 'b', REVIEW);
  assert.equal(status(result, 'a'), 'PAY'); assert.equal(status(result, 'b'), 'BLOCK'); assert.equal(getMetrics(result).reservedMinor, 60000);
  assert.equal(getLatestDecision(result, 'b').mode, 'human');
});

test('review rechecks the current version and cannot bypass a reduced hard limit', () => {
  const before = processed([invoice('a', { amount: '600.00' })]);
  const changed = updatePolicy(before, { ...structuredClone(before.policy), paymentLimit: '550.00' }, CTX);
  assert.equal(changed.policy.version, 2); assert.equal(before.policy.version, 1);
  const result = approveInvoice(changed, 'a', REVIEW);
  assert.equal(status(result, 'a'), 'BLOCK'); assert.equal(getLatestDecision(result, 'a').policyVersion, 2); assert.equal(getMetrics(result).reservedMinor, 0);
});

test('review rechecks a changed agreement and budget, never historical permissions', () => {
  let result = processed([invoice('a', { amount: '600.00' })]);
  const candidate = structuredClone(result.policy); candidate.beneficiaries[0].agreements[0].maxAmount = '550.00'; candidate.periodBudget = '500.00';
  result = updatePolicy(result, candidate, CTX); result = approveInvoice(result, 'a', REVIEW);
  assert.equal(status(result, 'a'), 'BLOCK');
  assert.equal(getLatestDecision(result, 'a').checks.find(check => check.ruleId === 'agreement-cap').passed, false);
  assert.equal(getLatestDecision(result, 'a').checks.find(check => check.ruleId === 'budget').passed, false);
});

test('duplicate reviews cannot produce a second business payment', () => {
  let result = processed([invoice('a', { number: 'SAME', amount: '600.00' }), invoice('b', { number: 'same', amount: '600.00' })]);
  assert.equal(status(result, 'a'), 'REVIEW'); assert.equal(status(result, 'b'), 'REVIEW');
  result = approveInvoice(result, 'a', REVIEW); result = approveInvoice(result, 'b', REVIEW);
  assert.equal(status(result, 'a'), 'PAY'); assert.equal(status(result, 'b'), 'BLOCK'); assert.equal(getMetrics(result).reservedMinor, 60000);
});

test('invalid calendar dates and invoices outside the authorized period stay in review', () => {
  const result = processed([invoice('bad', { dueDate: '2026-02-30' }), invoice('format', { dueDate: '16/10/2026' }), invoice('future', { dueDate: '2026-11-01' }), invoice('leap', { dueDate: '2026-02-29' })]);
  for (const id of ['bad', 'format', 'future', 'leap']) assert.equal(status(result, id), 'REVIEW');
  assert.equal(status(approveInvoice(result, 'future', REVIEW), 'future'), 'REVIEW');
  assert.equal(getLatestDecision(result, 'future').checks.find(check => check.ruleId === 'period').passed, false);
});

test('new period budget does not erase a reservation or recreate the available balance', () => {
  let result = processed([invoice('oct', { amount: '400.00' })], policy({ periodBudget: '500.00', availableBalance: '600.00' }));
  result = updatePolicy(result, { ...structuredClone(result.policy), period: '2026-11' }, CTX);
  assert.equal(getMetrics(result).remainingBudgetMinor, 50000); assert.equal(getMetrics(result).remainingBalanceMinor, 20000); assert.equal(getMetrics(result).reservedMinor, 40000);
  result = processInvoices(addInvoices(result, [invoice('nov', { dueDate: '2026-11-02', amount: '400.00' })], CTX), CTX);
  assert.equal(status(result, 'nov'), 'BLOCK'); assert.equal(getLatestDecision(result, 'oct').period, '2026-10');
});

test('a genuine leap date is valid in its explicitly authorized period', () => {
  const result = processed([invoice('leap', { dueDate: '2028-02-29' })], policy({ period: '2028-02' }));
  assert.equal(status(result, 'leap'), 'PAY');
});

test('policy versions are monotonic, stale writes are rejected, unchanged writes do nothing', () => {
  const initial = createState();
  assert.strictEqual(updatePolicy(initial, structuredClone(initial.policy), CTX), initial);
  const changed = updatePolicy(initial, { ...structuredClone(initial.policy), autoLimit: '450.00' }, CTX);
  assert.equal(changed.policy.version, 2); assert.equal(changed.audit.at(-1).previousPolicy.autoLimit, '500.00');
  assert.throws(() => updatePolicy(changed, { ...structuredClone(initial.policy), autoLimit: '400.00' }, CTX), { code: 'STALE_POLICY' });
  const second = updatePolicy(changed, { ...structuredClone(changed.policy), autoLimit: '400.00' }, CTX); assert.equal(second.policy.version, 3);
});

test('invalid policies, unsupported state schemas and prototype injection are rejected', () => {
  for (const changes of [{ version: 0 }, { version: 1.5 }, { currency: 'EUR' }, { period: '2026-1' }, { period: '2026-13' }, { period: '0000-01' }, { autoLimit: '2000.01' }, { periodBudget: 500 }, { extra: 'surprise' }]) assert.throws(() => createState(policy(changes)), DomainError);
  const duplicated = policy(); duplicated.beneficiaries.push(structuredClone(duplicated.beneficiaries[0])); assert.throws(() => createState(duplicated), DomainError);
  assert.throws(() => createState(JSON.parse('{"__proto__":{"polluted":true}}')), DomainError);
  assert.throws(() => addInvoices(createState(), [JSON.parse('{"id":"x","constructor":{"prototype":{"polluted":true}}}')]), DomainError);
  assert.throws(() => processInvoices({ ...createState(), schemaVersion: 2 }), { code: 'STATE_VERSION' });
  assert.equal({}.polluted, undefined);
});

test('reused input IDs with edited amounts cannot silently replace a paid invoice', () => {
  const result = processed([invoice('one')]);
  assert.throws(() => addInvoices(result, [invoice('one', { amount: '200.00' })], CTX), { code: 'INVOICE_ID_CONFLICT' });
  assert.equal(getMetrics(result).reservedMinor, 10000);
});

test('stored payment reservation, financial facts, ledger and rule evidence must remain mutually consistent', () => {
  const result = processed([invoice('paid')]);
  const zeroed = structuredClone(result); zeroed.decisions[0].amountMinor = 0;
  assert.throws(() => getMetrics(zeroed), { code: 'RESERVATION_INTEGRITY' });
  const rewritten = structuredClone(result); rewritten.invoices[0].amount = '1.00'; rewritten.decisions[0].amountMinor = 100;
  assert.throws(() => getMetrics(rewritten), { code: 'RESERVATION_INTEGRITY' });
  const ledger = structuredClone(result); ledger.decisions[0].reservedBefore.balanceMinor = 1;
  assert.throws(() => getMetrics(ledger), { code: 'RESERVATION_INTEGRITY' });
  const checks = structuredClone(result); checks.decisions[0].checks[0].passed = false;
  assert.throws(() => getMetrics(checks), { code: 'RESERVATION_INTEGRITY' });
  const rules = structuredClone(result); rules.decisions[0].policySnapshot.paymentLimit = '600.00';
  assert.throws(() => getMetrics(rules), { code: 'POLICY_INTEGRITY' });
  const missing = structuredClone(result); delete missing.decisions[0].policySnapshot;
  assert.throws(() => getMetrics(missing), DomainError);
});

test('policy history and current rules cannot contradict the same recorded version', () => {
  let result = processed([invoice('paid')]);
  result = updatePolicy(result, { ...structuredClone(result.policy), availableBalance: '2000.00' }, CTX);
  assert.equal(getMetrics(result).remainingBalanceMinor, 190000);
  const forged = structuredClone(result); forged.policy.availableBalance = '9000.00';
  assert.throws(() => getMetrics(forged), { code: 'POLICY_INTEGRITY' });
  const history = structuredClone(result); history.audit.find(entry => entry.type === 'POLICY_UPDATED').previousPolicy.paymentLimit = '1000.00';
  assert.throws(() => getMetrics(history), { code: 'POLICY_INTEGRITY' });
});

test('human rejection keeps history and cannot revoke a simulated reservation', () => {
  const before = processed([invoice('review', { amount: '600.00' }), invoice('paid')]);
  const result = rejectInvoice(before, 'review', REVIEW);
  assert.equal(status(result, 'review'), 'BLOCK'); assert.equal(result.decisions.length, 3); assert.equal(getMetrics(result).reservedMinor, 10000);
  assert.strictEqual(rejectInvoice(result, 'review', REVIEW), result);
  assert.throws(() => rejectInvoice(result, 'paid', REVIEW), { code: 'REVIEW_REQUIRED' });
});
