import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseInvoiceText, parseInvoiceCSV, parseInvoiceJSON, parseInvoiceFile, DEMO_INVOICES, DEMO_EXPECTATIONS } from '../src/import.js';
import { createState, addInvoices, processInvoices, getLatestDecision, getMetrics } from '../src/domain.js';

const textInvoice = `Mensaje de demostración. Todas las entidades son ficticias.
Factura: NST-044
Beneficiario ID: norte
Beneficiario: Norte Studio (ficticio)
Monto: 400.25
Moneda: USD
Vencimiento: 2026-10-18
Acuerdo: DES-01
Concepto: Diseño ficticio de material para el evento`;

const valid = { number: 'NST-044', beneficiaryId: 'norte', beneficiaryName: 'Norte Studio (ficticio)', amount: '400.25', currency: 'USD', dueDate: '2026-10-18', agreementId: 'DES-01', description: 'Diseño ficticio' };

test('extracts explicit Spanish fields and retains source text', () => {
  const invoice = parseInvoiceText(textInvoice, { idPrefix: 'paste-test' });
  assert.match(invoice.id, /^paste-test-\d+$/);
  assert.equal(invoice.number, valid.number);
  assert.equal(invoice.beneficiaryId, valid.beneficiaryId);
  assert.equal(invoice.beneficiaryName, valid.beneficiaryName);
  assert.equal(invoice.amount, '400.25');
  assert.equal(invoice.currency, 'USD');
  assert.equal(invoice.dueDate, '2026-10-18');
  assert.equal(invoice.agreementId, 'DES-01');
  assert.equal(invoice.sourceText, textInvoice);
  assert.deepEqual(invoice.extractionIssues, []);
});

test('extracts labeled English chat/email and unique repeated paste IDs', () => {
  const text = `Invoice number: AND-99\nSupplier ID: andina\nSupplier name: Andina Cloud (fictional)\nAmount: 75,2\nCurrency: USD\nDue date: 2026-10-30\nAgreement ID: CLOUD-01`;
  const first = parseInvoiceText(text), second = parseInvoiceText(text);
  assert.notEqual(first.id, second.id);
  assert.equal(first.amount, '75.20');
  assert.deepEqual(first.extractionIssues, []);
});

test('does not infer invoice facts from prose or currency symbols', () => {
  const invoice = parseInvoiceText('Please pay Norte $500 tomorrow. Our agreement is DES-01.');
  for (const field of ['number', 'beneficiaryId', 'beneficiaryName', 'amount', 'currency', 'dueDate', 'agreementId']) {
    assert.equal(invoice[field], '');
    assert.ok(invoice.extractionIssues.some(issue => issue.startsWith(`${field}:`)));
  }
});

test('conflicting repeated fields are ambiguous and not selected', () => {
  const invoice = parseInvoiceText(`${textInvoice}\nTotal: 800.00\nMoneda: EUR`);
  assert.equal(invoice.amount, '');
  assert.equal(invoice.currency, '');
  assert.ok(invoice.extractionIssues.some(issue => issue.includes('valores distintos')));
});

test('contradictory Total due cannot authorize the lower labeled amount', () => {
  const invoice = parseInvoiceText(textInvoice.replace('Monto: 400.25', 'Monto: 100.00') + '\nTotal due: 1000.00');
  assert.equal(invoice.amount, '');
  assert.ok(invoice.extractionIssues.some(issue => issue.startsWith('amount:')));
  const context = { actor: 'ambiguous-text-test', now: '2026-10-16T23:00:00.000Z' };
  const state = processInvoices(addInvoices(createState(), [invoice], context), context);
  assert.equal(getLatestDecision(state, invoice.id).status, 'REVIEW');
  assert.equal(getMetrics(state).reservedMinor, 0);
});

test('monetary synonyms are explicit amount fields, never ignored conflicts', () => {
  for (const label of ['Amount due', 'Total a pagar', 'Importe total', 'Amount payable', 'Grand total', 'Net payable', 'Balance due']) {
    const invoice = parseInvoiceText(textInvoice + `\n${label}: 1000.00`);
    assert.equal(invoice.amount, '', label);
    assert.ok(invoice.extractionIssues.some(issue => issue.startsWith('amount:')), label);
  }
});

test('unknown numeric or monetary fields fail closed without a brittle alias requirement', () => {
  for (const extra of ['Unrecognized settling figure: 1000.00', 'Final remittance: USD 1000.00', 'Liquidación definitiva: $1000', 'Monto de otra referencia: confirmar', 'Unfamiliar settling amount sentence 1000.00', 'Otra cifra desconocida: 1,000.00 gross', 'Total due 1000.00', `${'unrecognized '.repeat(20)}: 1000.00`]) {
    const invoice = parseInvoiceText(textInvoice + `\n${extra}`);
    assert.ok(invoice.extractionIssues.some(issue => issue.startsWith('amount:')), extra);
    const context = { actor: 'unknown-money-test', now: '2026-10-16T23:00:00.000Z' };
    const state = processInvoices(addInvoices(createState(), [invoice], context), context);
    assert.equal(getLatestDecision(state, invoice.id).status, 'REVIEW', extra);
  }
});

test('Convenio and ID convenio match explicit agreement IDs in the UI example', () => {
  for (const label of ['Convenio', 'ID convenio']) {
    const invoice = parseInvoiceText(textInvoice.replace('Acuerdo:', `${label}:`));
    assert.equal(invoice.agreementId, 'DES-01');
    assert.deepEqual(invoice.extractionIssues, []);
    const context = { actor: 'ui-example-test', now: '2026-10-16T23:00:00.000Z' };
    const state = processInvoices(addInvoices(createState(), [invoice], context), context);
    assert.equal(getLatestDecision(state, invoice.id).status, 'PAY');
  }
});

test('invisible invoice numbers are uncertain and never hidden duplicates', () => {
  for (const number of ['NST-0\u200B44', 'NST-0\u206044', 'NST-044\u00A0X', 'ＮＳＴ-044']) {
    const [invoice] = parseInvoiceJSON(JSON.stringify([{ ...valid, number }]));
    assert.ok(invoice.extractionIssues.some(issue => issue.startsWith('number:')), number);
    const context = { actor: 'number-test', now: '2026-10-16T23:00:00.000Z' };
    const state = processInvoices(addInvoices(createState(), [invoice], context), context);
    assert.notEqual(getLatestDecision(state, invoice.id).status, 'PAY');
  }
});

test('identical repeated labels do not introduce false ambiguity', () => {
  assert.equal(parseInvoiceText(`${textInvoice}\nMonto: 400.25`).extractionIssues.length, 0);
});

test('money parsing never guesses grouping, rounds or loses precision', () => {
  for (const amount of ['1,000', '1.234', '1,234.56', '$500', '5e2', '-1', 'NaN', '0', '90071992547409.92', '0005']) {
    const invoice = parseInvoiceJSON(JSON.stringify([{ ...valid, amount }]))[0];
    assert.ok(invoice.extractionIssues.some(issue => issue.startsWith('amount:')), amount);
  }
  const exact = parseInvoiceJSON(JSON.stringify([{ ...valid, amount: '90071992547409.91' }]))[0];
  assert.equal(exact.amount, '90071992547409.91');
  assert.equal(exact.extractionIssues.length, 0);
});

test('invalid dates and unlabeled inferred currency remain uncertain', () => {
  for (const dueDate of ['2026-02-30', '2026-13-01', '18/10/2026', 'tomorrow']) {
    assert.ok(parseInvoiceJSON(JSON.stringify([{ ...valid, dueDate }]))[0].extractionIssues.some(issue => issue.startsWith('dueDate:')));
  }
  assert.ok(parseInvoiceJSON(JSON.stringify([{ ...valid, currency: 'usd' }]))[0].extractionIssues.some(issue => issue.startsWith('currency:')));
});

test('CSV supports BOM, CRLF, commas, escaped quotes and quoted multiline cells', () => {
  const csv = '\uFEFFnumber,beneficiaryId,beneficiaryName,amount,currency,dueDate,agreementId,description\r\n"NST-044",norte,"Norte, Studio (ficticio)",400.25,USD,2026-10-18,DES-01,"Diseño ""Norte""\nsegunda línea"\r\n';
  const [invoice] = parseInvoiceCSV(csv, { idPrefix: 'csv-proof' });
  assert.equal(invoice.id, 'csv-proof-0001');
  assert.equal(invoice.beneficiaryName, 'Norte, Studio (ficticio)');
  assert.equal(invoice.description, 'Diseño "Norte"\nsegunda línea');
  assert.deepEqual(invoice.extractionIssues, []);
});

test('malformed CSV fails with actionable errors', () => {
  for (const csv of ['number,amount\n"a,20', 'number,amount\na"b,20', 'number,amount\n"a"x,20', 'number,amount\na,20,30', 'number,invoice number\na,b', '__proto__,amount\na,20']) {
    assert.throws(() => parseInvoiceCSV(csv));
  }
});

test('unknown CSV columns do not become invoice facts and force review', () => {
  const [invoice] = parseInvoiceCSV('number,total,untrusted\nNST-1,500,whatever');
  assert.equal(invoice.number, 'NST-1');
  assert.equal(invoice.amount, '500.00');
  assert.ok(invoice.extractionIssues.some(issue => issue.includes('columnas desconocidas')));
  assert.equal(Object.hasOwn(invoice, 'untrusted'), false);
});

test('JSON supports array, single object and invoices wrapper; generates IDs', () => {
  for (const data of [[valid], valid, { invoices: [valid] }]) {
    const [invoice] = parseInvoiceJSON(JSON.stringify(data), { idPrefix: 'json-proof' });
    assert.equal(invoice.id, 'json-proof-0001');
    assert.equal(invoice.amount, '400.25');
  }
  const invoices = parseInvoiceJSON(JSON.stringify([{ ...valid, id: 'evil-duplicate' }, { ...valid, id: 'evil-duplicate' }]));
  assert.notEqual(invoices[0].id, invoices[1].id);
});

test('JSON rejects prototype keys recursively and schema violations', () => {
  for (const text of ['[{"__proto__":{"polluted":true}}]', '[{"constructor":{}}]', '{"invoices":[],"meta":{"prototype":1}}', 'null', '[[]]', '[{"amount":"1","extra":1}]', '[{"extractionIssues":[1]}]']) {
    assert.throws(() => parseInvoiceJSON(text), text);
  }
  assert.equal({}.polluted, undefined);
});

test('JSON numeric amount is not coerced into potentially lossy money', () => {
  const [invoice] = parseInvoiceJSON(JSON.stringify([{ ...valid, amount: 400.25 }]));
  assert.equal(invoice.amount, '');
  assert.ok(invoice.extractionIssues.some(issue => issue.startsWith('amount:')));
});

test('JSON duplicate keys cannot silently replace amounts or identity', () => {
  for (const text of ['[{"amount":"100","amount":"400"}]', '[{"amount":"100","\\u0061mount":"400"}]', '{"invoices":[{}],"invoices":[{}]}']) {
    assert.throws(() => parseInvoiceJSON(text), /clave repetida/);
  }
});

test('CSV preserves extraction warnings instead of laundering uncertainty', () => {
  const [invoice] = parseInvoiceCSV('number,amount,extractionIssues\nNST-1,100,"[""amount: confirmar importe""]"');
  assert.ok(invoice.extractionIssues.includes('amount: confirmar importe'));
});

test('HTML payload stays inert text and no DOM/evaluation calls are made', () => {
  const payload = '<img src=x onerror="globalThis.stolen=true">';
  const [invoice] = parseInvoiceJSON(JSON.stringify([{ ...valid, beneficiaryName: payload, description: '<script>alert(1)</script>' }]));
  assert.equal(invoice.beneficiaryName, payload);
  assert.equal(invoice.description, '<script>alert(1)</script>');
  assert.equal(globalThis.stolen, undefined);
});

test('bounded input, row counts, field sizes and prefix validation', () => {
  assert.throws(() => parseInvoiceText('x'.repeat(1_000_001)), /límite/);
  assert.throws(() => parseInvoiceText('Factura: \u0000x'), /binarios/);
  assert.throws(() => parseInvoiceJSON(JSON.stringify(Array(501).fill(valid))), /500/);
  assert.throws(() => parseInvoiceCSV('number\n' + Array(501).fill('x').join('\n')), /500/);
  assert.throws(() => parseInvoiceJSON(JSON.stringify([{ ...valid, description: 'x'.repeat(12_001) }])), /supera/);
  assert.throws(() => parseInvoiceText(textInvoice, { idPrefix: '<unsafe>' }), /idPrefix/);
});

test('dispatch supported plain text files and explicitly refuses PDF/OCR', () => {
  assert.equal(parseInvoiceFile(textInvoice, 'invoice.TXT').length, 1);
  assert.equal(parseInvoiceFile(JSON.stringify(valid), 'invoice.json').length, 1);
  assert.equal(parseInvoiceFile('number,amount\nINV-1,100', 'invoice.csv').length, 1);
  for (const filename of ['invoice.pdf', 'invoice.png', 'invoice.jpg']) assert.throws(() => parseInvoiceFile('', filename), /no hace OCR/);
  assert.throws(() => parseInvoiceFile('', 'invoice.xlsx'), /Formato no soportado/);
});

test('demo fixture has independent expected result per unique fictional invoice', () => {
  assert.equal(DEMO_INVOICES.length, 16);
  assert.equal(new Set(DEMO_INVOICES.map(invoice => invoice.id)).size, 16);
  assert.deepEqual(Object.keys(DEMO_EXPECTATIONS), DEMO_INVOICES.map(invoice => invoice.id));
  assert.deepEqual(Object.values(DEMO_EXPECTATIONS).reduce((counts, status) => ({ ...counts, [status]: (counts[status] || 0) + 1 }), {}), { PAY: 6, BLOCK: 6, REVIEW: 4 });
  assert.ok(DEMO_INVOICES.every(invoice => invoice.beneficiaryName.includes('ficticio')));
});

test('every integrated demo decision independently matches expected outcome and exact reserves', () => {
  const context = { actor: 'fixture-test', now: '2026-10-16T23:00:00.000Z' };
  const state = processInvoices(addInvoices(createState(), DEMO_INVOICES, context), context);
  for (const invoice of DEMO_INVOICES) assert.equal(getLatestDecision(state, invoice.id).status, DEMO_EXPECTATIONS[invoice.id], invoice.id);
  const metrics = getMetrics(state);
  assert.equal(metrics.pay, 6);
  assert.equal(metrics.block, 6);
  assert.equal(metrics.review, 4);
  assert.equal(metrics.reservedMinor, 280000);
  assert.equal(metrics.remainingBudgetMinor, 70000);
  assert.equal(metrics.remainingBalanceMinor, 20000);
});

test('actual distributed TXT, CSV and JSON samples produce documented decisions', async () => {
  const expected = { 'invoice-message.txt': ['PAY'], 'invoices.csv': ['PAY', 'REVIEW', 'BLOCK'], 'invoices.json': ['PAY', 'REVIEW'] };
  const context = { actor: 'sample-test', now: '2026-10-16T23:00:00.000Z' };
  for (const [filename, statuses] of Object.entries(expected)) {
    const text = await readFile(new URL(`../fixtures/${filename}`, import.meta.url), 'utf8');
    const invoices = parseInvoiceFile(text, filename, { idPrefix: 'sample' });
    const state = processInvoices(addInvoices(createState(), invoices, context), context);
    assert.deepEqual(invoices.map(invoice => getLatestDecision(state, invoice.id).status), statuses, filename);
  }
});
