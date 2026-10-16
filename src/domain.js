/** Local, deterministic policy engine. PAY is a simulated reservation, never a transfer. */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const POLICY_KEYS = ['version', 'currency', 'autoLimit', 'paymentLimit', 'periodBudget', 'availableBalance', 'period', 'beneficiaries'];
const INVOICE_KEYS = ['id', 'number', 'beneficiaryId', 'beneficiaryName', 'amount', 'currency', 'dueDate', 'agreementId', 'description', 'sourceText', 'extractionIssues'];
const MAX_ROWS = 2000;
const MAX_MONEY = 1_000_000_000_000;

export class DomainError extends Error {
  constructor(message, code = 'INVALID_INPUT') { super(message); this.name = 'DomainError'; this.code = code; }
}

function assert(condition, message, code) { if (!condition) throw new DomainError(message, code); }
function ownObject(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label}: se requiere un objeto.`);
  const proto = Object.getPrototypeOf(value);
  assert(proto === Object.prototype || proto === null, `${label}: prototipo no permitido.`);
  return value;
}
function inspectSafe(value, depth = 0) {
  assert(depth <= 20, 'Estructura demasiado profunda.');
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) ownObject(value, 'Dato');
  for (const key of Object.keys(value)) {
    assert(!UNSAFE_KEYS.has(key), 'Clave de objeto no permitida.');
    inspectSafe(value[key], depth + 1);
  }
}
function exactKeys(object, keys, label) {
  ownObject(object, label);
  assert(Object.keys(object).every(key => keys.includes(key)), `${label}: campo no reconocido.`);
  assert(keys.every(key => Object.hasOwn(object, key)), `${label}: falta un campo obligatorio.`);
}
function text(value, label, max = 200) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), `${label}: texto inválido.`);
  return value.trim();
}
function normalize(value) { return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es'); }
// Invoice identifiers are financial identity, not free-form prose. Invisible,
// directional, Unicode separator and confusable characters require correction.
function invoiceNumberIsSafe(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/.test(value); }
function supplierName(value) { return normalize(value).replace(/\s*\(fictici[oa]\)\s*$/, '').trim(); }
function periodIsValid(value) { return typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function dateIsValid(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function parseMoney(value) {
  assert(typeof value === 'string' && /^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value) && value.length <= 20, 'Monto inválido. Escribe un decimal positivo con hasta dos decimales.', 'INVALID_MONEY');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  assert(amount <= BigInt(Number.MAX_SAFE_INTEGER), 'Monto fuera del rango exacto.', 'INVALID_MONEY');
  return Number(amount);
}

export function formatMoney(minor, currency = 'USD') {
  assert(Number.isSafeInteger(minor), 'Importe en centavos inválido.', 'INVALID_MONEY');
  assert(typeof currency === 'string' && /^[A-Z]{3}$/.test(currency), 'Moneda inválida.');
  const negative = minor < 0;
  const n = BigInt(negative ? -minor : minor);
  return `${negative ? '-' : ''}${currency} ${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
}

function validatePolicy(candidate) {
  inspectSafe(candidate);
  exactKeys(candidate, POLICY_KEYS, 'Política');
  assert(Number.isSafeInteger(candidate.version) && candidate.version >= 1 && candidate.version < Number.MAX_SAFE_INTEGER, 'Versión de política inválida.', 'POLICY_VERSION');
  assert(candidate.currency === 'USD', 'La simulación admite USD exclusivamente.');
  assert(periodIsValid(candidate.period), 'El período debe tener el formato YYYY-MM.');
  const values = {};
  for (const key of ['autoLimit', 'paymentLimit', 'periodBudget', 'availableBalance']) {
    values[key] = parseMoney(candidate[key]);
    assert(values[key] <= MAX_MONEY, 'Límite de política demasiado alto.');
  }
  assert(values.paymentLimit > 0 && values.autoLimit <= values.paymentLimit, 'El límite automático no debe superar el límite absoluto.');
  assert(Array.isArray(candidate.beneficiaries) && candidate.beneficiaries.length <= 200, 'Lista de beneficiarios inválida.');
  const seen = new Set();
  const beneficiaries = candidate.beneficiaries.map(beneficiary => {
    exactKeys(beneficiary, ['id', 'name', 'enabled', 'agreements'], 'Beneficiario');
    const id = text(beneficiary.id, 'ID del beneficiario', 100);
    assert(!seen.has(normalize(id)), 'ID de beneficiario repetido.'); seen.add(normalize(id));
    assert(typeof beneficiary.enabled === 'boolean', 'Estado del beneficiario inválido.');
    assert(Array.isArray(beneficiary.agreements) && beneficiary.agreements.length <= 100, 'Acuerdos inválidos.');
    const agreementsSeen = new Set();
    const agreements = beneficiary.agreements.map(agreement => {
      exactKeys(agreement, ['id', 'maxAmount', 'currency'], 'Acuerdo');
      const agreementId = text(agreement.id, 'ID del acuerdo', 100);
      assert(!agreementsSeen.has(normalize(agreementId)), 'ID de acuerdo repetido.'); agreementsSeen.add(normalize(agreementId));
      assert(agreement.currency === candidate.currency, 'Moneda del acuerdo incompatible.');
      const maximum = parseMoney(agreement.maxAmount);
      assert(maximum > 0 && maximum <= MAX_MONEY, 'Tope de acuerdo inválido.');
      return { id: agreementId, maxAmount: agreement.maxAmount, currency: agreement.currency };
    });
    return { id, name: text(beneficiary.name, 'Nombre del beneficiario'), enabled: beneficiary.enabled, agreements };
  });
  return { version: candidate.version, currency: 'USD', autoLimit: candidate.autoLimit, paymentLimit: candidate.paymentLimit, periodBudget: candidate.periodBudget, availableBalance: candidate.availableBalance, period: candidate.period, beneficiaries };
}

function deepFreeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child); return value; }
export const DEFAULT_POLICY = deepFreeze({
  version: 1, currency: 'USD', autoLimit: '500.00', paymentLimit: '2000.00', periodBudget: '3500.00', availableBalance: '3000.00', period: '2026-10',
  beneficiaries: [
    { id: 'norte', name: 'Norte Studio (ficticio)', enabled: true, agreements: [{ id: 'DES-01', maxAmount: '700.00', currency: 'USD' }] },
    { id: 'andina', name: 'Andina Cloud (ficticia)', enabled: true, agreements: [{ id: 'CLOUD-01', maxAmount: '1200.00', currency: 'USD' }] },
    { id: 'brisa', name: 'Brisa Contenido (ficticio)', enabled: true, agreements: [{ id: 'COPY-01', maxAmount: '600.00', currency: 'USD' }] },
    { id: 'oriente', name: 'Taller Oriente (ficticio)', enabled: true, agreements: [{ id: 'OPS-01', maxAmount: '2000.00', currency: 'USD' }] }
  ]
});

function contextData(context = {}) {
  inspectSafe(context); ownObject(context, 'Contexto');
  const actor = context.actor === undefined ? 'motor-local' : text(context.actor, 'Actor');
  const at = context.now === undefined ? new Date().toISOString() : context.now;
  assert(typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(at) && Number.isFinite(Date.parse(at)), 'Fecha de auditoría inválida.');
  const note = context.note === undefined ? '' : text(context.note, 'Justificación', 2000);
  return { actor, at, note };
}
function substantiveNote(context) {
  assert(context.note.length >= 12 && context.note.split(/\s+/).length >= 3, 'Escribe una justificación de al menos tres palabras y doce caracteres.', 'NOTE_REQUIRED');
}
function validateState(state) {
  inspectSafe(state); ownObject(state, 'Estado');
  assert(state.schemaVersion === 1 && Number.isSafeInteger(state.revision) && state.revision >= 0, 'Estado o versión incompatible.', 'STATE_VERSION');
  validatePolicy(state.policy);
  assert(Array.isArray(state.invoices) && state.invoices.length <= MAX_ROWS && Array.isArray(state.decisions) && state.decisions.length <= 20000 && Array.isArray(state.audit) && state.audit.length <= 30000, 'Historial inválido.');
  // These consistency checks detect incomplete or contradictory local history.
  // They do not authenticate browser storage against its owner's deliberate edits.
  const knownPolicies = new Map([[state.policy.version, JSON.stringify(state.policy)]]);
  let lastPolicy = null;
  for (const entry of state.audit) {
    ownObject(entry, 'Evento de bitácora');
    if (entry.type !== 'POLICY_UPDATED') continue;
    const previous = validatePolicy(entry.previousPolicy), next = validatePolicy(entry.policy);
    assert(next.version === previous.version + 1 && (!lastPolicy || JSON.stringify(previous) === JSON.stringify(lastPolicy)), 'Cadena de versiones de política inconsistente.', 'POLICY_INTEGRITY');
    for (const recorded of [previous, next]) {
      const serialized = JSON.stringify(recorded);
      assert(!knownPolicies.has(recorded.version) || knownPolicies.get(recorded.version) === serialized, 'Una versión de política contiene reglas contradictorias.', 'POLICY_INTEGRITY');
      knownPolicies.set(recorded.version, serialized);
    }
    lastPolicy = next;
  }
  assert(!lastPolicy || JSON.stringify(lastPolicy) === JSON.stringify(state.policy), 'Las reglas actuales no corresponden a la última actualización registrada.', 'POLICY_INTEGRITY');
  const invoiceIds = new Set(), invoiceById = new Map();
  for (const invoice of state.invoices) {
    ownObject(invoice, 'Factura');
    assert(typeof invoice.id === 'string' && invoice.id.trim() && !invoiceIds.has(invoice.id), 'ID de factura inválido o repetido.'); invoiceIds.add(invoice.id); invoiceById.set(invoice.id, invoice);
  }
  const decisionIds = new Set();
  const paidIds = new Set();
  const paidBusiness = new Set();
  const historicalLedger = { all: 0, periods: new Map(), business: new Set() };
  for (const decision of state.decisions) {
    ownObject(decision, 'Decisión');
    assert(typeof decision.id === 'string' && !decisionIds.has(decision.id) && invoiceIds.has(decision.invoiceId) && ['PAY', 'BLOCK', 'REVIEW'].includes(decision.status), 'Decisión inválida.'); decisionIds.add(decision.id);
    assert(Number.isSafeInteger(decision.amountMinor) && decision.amountMinor >= 0, 'Reserva inválida.');
    assert(Number.isSafeInteger(decision.policyVersion) && decision.policyVersion >= 1 && decision.policyVersion <= state.policy.version, 'Versión histórica de decisión inválida.');
    assert(Array.isArray(decision.reasons) && decision.reasons.length && decision.reasons.every(reason => typeof reason === 'string') && Array.isArray(decision.checks) && decision.checks.every(check => check && typeof check.ruleId === 'string' && typeof check.label === 'string' && typeof check.reason === 'string' && typeof check.passed === 'boolean'), 'Evidencia de decisión inválida.');
    if (decision.status === 'PAY') {
      const invoice = invoiceById.get(decision.invoiceId);
      const business = businessKey(invoice);
      assert(periodIsValid(decision.period) && invoiceNumberIsSafe(invoice.number) && !paidIds.has(decision.invoiceId) && !paidBusiness.has(business), 'Reserva duplicada, identificador ambiguo o período inválido.');
      assert(decision.amountMinor === parseMoney(invoice.amount) && decision.amountMinor > 0, 'La reserva histórica no coincide con el importe de la factura.', 'RESERVATION_INTEGRITY');
      assert(decision.invoiceSnapshot && JSON.stringify(decision.invoiceSnapshot) === JSON.stringify(invoiceFacts(invoice)), 'Los datos financieros cambiaron después de la decisión.', 'RESERVATION_INTEGRITY');
      const historicalPolicy = validatePolicy(decision.policySnapshot);
      assert(historicalPolicy.version === decision.policyVersion && historicalPolicy.period === decision.period, 'La política histórica no coincide con la decisión.', 'RESERVATION_INTEGRITY');
      assert(knownPolicies.get(historicalPolicy.version) === JSON.stringify(historicalPolicy), 'Las reglas de la reserva contradicen el historial de políticas.', 'POLICY_INTEGRITY');
      const historicalPeriod = historicalLedger.periods.get(decision.period) ?? 0;
      assert(decision.reservedBefore && decision.reservedBefore.balanceMinor === historicalLedger.all && decision.reservedBefore.periodMinor === historicalPeriod, 'La reserva no coincide con el historial secuencial.', 'RESERVATION_INTEGRITY');
      const human = decision.mode === 'human';
      assert(human || decision.mode === 'automatic', 'Modo de decisión inválido.');
      if (human) substantiveNote({ note: decision.note ?? '' });
      const replay = evaluate({ policy: historicalPolicy }, invoice, { all: historicalLedger.all, period: historicalPeriod, business: historicalLedger.business }, human);
      assert(replay.status === 'PAY' && replay.amountMinor === decision.amountMinor && JSON.stringify(replay.checks) === JSON.stringify(decision.checks), 'La reserva histórica no supera las reglas registradas.', 'RESERVATION_INTEGRITY');
      historicalLedger.all += decision.amountMinor;
      assert(Number.isSafeInteger(historicalLedger.all), 'Reservas históricas fuera de rango.');
      historicalLedger.periods.set(decision.period, historicalPeriod + decision.amountMinor);
      historicalLedger.business.add(business);
      paidIds.add(decision.invoiceId); paidBusiness.add(business);
    }
  }
}

export function createState(policy = DEFAULT_POLICY) {
  return { schemaVersion: 1, revision: 0, policyRevision: 0, policy: validatePolicy(policy), invoices: [], decisions: [], audit: [] };
}
function auditEntry(state, context, type, details = {}) {
  return { id: `audit-${state.audit.length + 1}`, revision: state.revision + 1, at: context.at, actor: context.actor, type, ...details };
}

export function addInvoices(state, invoices, context = {}) {
  validateState(state); const ctx = contextData(context);
  inspectSafe(invoices);
  assert(Array.isArray(invoices) && invoices.length <= MAX_ROWS, 'Importación de facturas inválida.');
  const known = new Map(state.invoices.map(invoice => [invoice.id, invoice]));
  const fresh = [];
  for (const row of invoices) {
    ownObject(row, 'Factura');
    assert(Object.keys(row).every(key => INVOICE_KEYS.includes(key)), 'Factura: campo no reconocido.');
    const invoice = { id: text(row.id, 'ID de factura', 150) };
    const extractionIssues = [];
    for (const key of INVOICE_KEYS.filter(key => key !== 'id' && key !== 'extractionIssues')) {
      if (row[key] === undefined || row[key] === null) invoice[key] = '';
      else if (typeof row[key] === 'string' && row[key].length <= (key === 'sourceText' ? 40000 : 2000)) invoice[key] = row[key].trim();
      else { invoice[key] = ''; extractionIssues.push(`Campo ${key} con formato inválido.`); }
    }
    if (row.extractionIssues !== undefined) {
      assert(Array.isArray(row.extractionIssues) && row.extractionIssues.length <= 100 && row.extractionIssues.every(issue => typeof issue === 'string' && issue.length <= 2000), 'Observaciones de extracción inválidas.');
      extractionIssues.push(...row.extractionIssues.map(issue => issue.trim()).filter(Boolean));
    }
    invoice.extractionIssues = [...new Set(extractionIssues)];
    const existing = known.get(invoice.id);
    if (existing) { assert(JSON.stringify(existing) === JSON.stringify(invoice), 'Un ID existente contiene datos distintos. Importa la corrección con otro ID.', 'INVOICE_ID_CONFLICT'); continue; }
    known.set(invoice.id, invoice); fresh.push(invoice);
  }
  if (!fresh.length) return state;
  assert(state.invoices.length + fresh.length <= MAX_ROWS, `Se admiten hasta ${MAX_ROWS} facturas por espacio local.`);
  return { ...state, revision: state.revision + 1, invoices: [...state.invoices, ...fresh], audit: [...state.audit, auditEntry(state, ctx, 'INVOICES_ADDED', { count: fresh.length, invoiceIds: fresh.map(invoice => invoice.id) })] };
}

function latestMap(state) { const map = new Map(); for (const decision of state.decisions) map.set(decision.invoiceId, decision); return map; }
export function getLatestDecision(state, invoiceId) { validateState(state); return latestMap(state).get(invoiceId) ?? null; }
function businessKey(invoice) { return `${normalize(invoice.beneficiaryId)}\u0000${normalize(invoice.number)}`; }
function invoiceFacts(invoice) {
  return Object.fromEntries(INVOICE_KEYS.filter(key => key !== 'sourceText').map(key => [key, key === 'extractionIssues' ? [...(invoice.extractionIssues ?? [])] : invoice[key]]));
}
function reservations(state) {
  let all = 0, period = 0;
  const business = new Set();
  for (const decision of state.decisions) {
    if (decision.status !== 'PAY') continue;
    all += decision.amountMinor;
    assert(Number.isSafeInteger(all), 'Reservas fuera de rango.');
    if (decision.period === state.policy.period) period += decision.amountMinor;
    const invoice = state.invoices.find(item => item.id === decision.invoiceId);
    business.add(businessKey(invoice));
  }
  return { all, period, business };
}
function evaluate(state, invoice, reserved, human = false) {
  const checks = [], hard = [], review = [];
  function check(ruleId, label, passed, reason, severity = 'review') {
    checks.push({ ruleId, label, passed: Boolean(passed), reason });
    if (!passed) (severity === 'hard' ? hard : review).push(reason);
  }
  const required = ['number', 'beneficiaryId', 'beneficiaryName', 'amount', 'currency', 'dueDate', 'agreementId', 'description'];
  const missing = required.filter(key => typeof invoice[key] !== 'string' || !invoice[key].trim());
  check('fields', 'Datos obligatorios', missing.length === 0, missing.length ? `Faltan campos: ${missing.join(', ')}.` : 'Datos obligatorios presentes.');
  check('invoice-number', 'Número de factura inequívoco', invoiceNumberIsSafe(invoice.number), invoiceNumberIsSafe(invoice.number) ? 'Identificador explícito sin caracteres ambiguos.' : 'Número de factura ausente o con caracteres invisibles, de control o no admitidos. Corrige la entrada original.');
  const issues = Array.isArray(invoice.extractionIssues) ? invoice.extractionIssues.filter(Boolean) : [];
  check('extraction', 'Extracción sin ambigüedad', issues.length === 0, issues.length ? `Revisar extracción: ${issues.join(' ')}` : 'Sin ambigüedades de extracción declaradas.');
  let amountMinor = 0, validAmount = false;
  try { amountMinor = parseMoney(invoice.amount); validAmount = amountMinor > 0; } catch { /* Ambiguous input remains reviewable, never coerced. */ }
  check('amount', 'Monto exacto y positivo', validAmount, validAmount ? 'Monto validado en centavos enteros.' : 'Monto ausente, ambiguo, no positivo o fuera de rango.');
  const currencyPresent = Boolean(invoice.currency);
  check('currency', 'Moneda admitida', invoice.currency === state.policy.currency, invoice.currency === state.policy.currency ? 'Factura y política en USD.' : (currencyPresent ? 'Moneda distinta de USD. No se aplica conversión automática.' : 'Falta la moneda explícita.'), currencyPresent ? 'hard' : 'review');
  const validDate = dateIsValid(invoice.dueDate);
  check('date', 'Fecha válida', validDate, validDate ? 'Fecha de vencimiento válida.' : 'Fecha ausente o inválida. Se requiere YYYY-MM-DD.');
  const samePeriod = validDate && invoice.dueDate.slice(0, 7) === state.policy.period;
  check('period', 'Período autorizado', samePeriod, samePeriod ? `Vencimiento dentro de ${state.policy.period}.` : `El vencimiento no corresponde al período autorizado ${state.policy.period}. La fecha no concede autorización por sí misma.`);
  const beneficiary = state.policy.beneficiaries.find(item => normalize(item.id) === normalize(invoice.beneficiaryId));
  check('beneficiary', 'Beneficiario autorizado', Boolean(beneficiary), beneficiary ? 'ID encontrado en la lista autorizada.' : 'Beneficiario desconocido. Requiere alta y verificación en las reglas.');
  if (beneficiary) {
    check('beneficiary-enabled', 'Beneficiario habilitado', beneficiary.enabled, beneficiary.enabled ? 'Beneficiario habilitado.' : 'Beneficiario deshabilitado por la política.', 'hard');
    check('beneficiary-name', 'Nombre e identidad coherentes', supplierName(invoice.beneficiaryName) === supplierName(beneficiary.name), supplierName(invoice.beneficiaryName) === supplierName(beneficiary.name) ? 'Nombre coherente con el beneficiario autorizado.' : 'El nombre no coincide con el ID autorizado. Verifica la identidad.');
    const agreement = beneficiary.agreements.find(item => normalize(item.id) === normalize(invoice.agreementId));
    const hasAgreement = Boolean(invoice.agreementId);
    check('agreement', 'Acuerdo del beneficiario', Boolean(agreement), agreement ? 'Acuerdo asignado al beneficiario.' : (hasAgreement ? 'El acuerdo no pertenece al beneficiario autorizado.' : 'Falta identificar el acuerdo.'), hasAgreement ? 'hard' : 'review');
    if (agreement && validAmount) check('agreement-cap', 'Tope del acuerdo', amountMinor <= parseMoney(agreement.maxAmount), amountMinor <= parseMoney(agreement.maxAmount) ? 'Monto dentro del tope acordado.' : `Monto superior al tope ${formatMoney(parseMoney(agreement.maxAmount))} del acuerdo.`, 'hard');
  }
  const duplicate = Boolean(invoice.number && invoice.beneficiaryId && reserved.business.has(businessKey(invoice)));
  check('duplicate', 'Factura sin pago previo', !duplicate, duplicate ? 'La misma factura y beneficiario ya tienen una reserva simulada. No se admite un segundo pago.' : 'Sin reserva previa para esta factura y beneficiario.', 'hard');
  if (validAmount) {
    check('payment-limit', 'Límite absoluto', amountMinor <= parseMoney(state.policy.paymentLimit), amountMinor <= parseMoney(state.policy.paymentLimit) ? 'Monto dentro del límite absoluto por factura.' : 'Monto superior al límite absoluto. Una aprobación humana no lo omite.', 'hard');
    check('budget', 'Presupuesto disponible', amountMinor <= parseMoney(state.policy.periodBudget) - reserved.period, amountMinor <= parseMoney(state.policy.periodBudget) - reserved.period ? `Presupuesto disponible en ${state.policy.period}.` : 'Presupuesto del período insuficiente después de reservas previas.', 'hard');
    check('balance', 'Saldo disponible', amountMinor <= parseMoney(state.policy.availableBalance) - reserved.all, amountMinor <= parseMoney(state.policy.availableBalance) - reserved.all ? 'Saldo simulado suficiente después de reservas previas.' : 'Saldo simulado insuficiente después de reservas previas.', 'hard');
    check('auto-limit', 'Umbral de autonomía', human || amountMinor <= parseMoney(state.policy.autoLimit), human ? 'Revisión humana documentada. Los límites absolutos siguen vigentes.' : (amountMinor <= parseMoney(state.policy.autoLimit) ? 'Dentro del umbral automático.' : 'Supera el umbral automático. Requiere revisión humana.'));
  }
  return { status: hard.length ? 'BLOCK' : review.length ? 'REVIEW' : 'PAY', reasons: hard.length ? [...hard, ...review] : review.length ? review : ['Todas las reglas aplicables aprobadas. Reserva simulada registrada.'], checks, amountMinor: validAmount ? amountMinor : 0 };
}

function newDecision(state, invoice, result, context, mode, reserved) {
  const evidence = result.status === 'PAY' ? { invoiceSnapshot: invoiceFacts(invoice), policySnapshot: structuredClone(state.policy), reservedBefore: { balanceMinor: reserved.all, periodMinor: reserved.period } } : {};
  return { id: `decision-${state.decisions.length + 1}`, invoiceId: invoice.id, ...result, policyVersion: state.policy.version, policyRevision: state.policyRevision ?? 0, inputRevision: state.revision, period: state.policy.period, at: context.at, actor: context.actor, mode, ...evidence, ...(context.note ? { note: context.note } : {}) };
}
export function processInvoices(state, context = {}) {
  validateState(state); const ctx = contextData(context);
  const latest = latestMap(state), pending = state.invoices.filter(invoice => !latest.has(invoice.id));
  if (!pending.length) return state;
  const reserved = reservations(state), decisions = [...state.decisions], audit = [...state.audit];
  for (const invoice of pending) {
    const working = { ...state, decisions, audit };
    const result = evaluate(working, invoice, reserved);
    const decision = newDecision(working, invoice, result, ctx, 'automatic', reserved);
    decisions.push(decision);
    audit.push(auditEntry(working, ctx, 'INVOICE_DECIDED', { invoiceId: invoice.id, decisionId: decision.id, status: decision.status, reasons: [...decision.reasons], policyRevision: decision.policyRevision }));
    if (result.status === 'PAY') { reserved.all += result.amountMinor; reserved.period += result.amountMinor; reserved.business.add(businessKey(invoice)); }
  }
  return { ...state, revision: state.revision + 1, decisions, audit };
}

export function updatePolicy(state, candidate, context = {}) {
  validateState(state); const ctx = contextData(context), policy = validatePolicy(candidate);
  assert(policy.version === state.policy.version, 'La política cambió en otra revisión. Recarga las reglas actuales.', 'STALE_POLICY');
  if (JSON.stringify(state.policy) === JSON.stringify(policy)) return state;
  assert(policy.version < Number.MAX_SAFE_INTEGER - 1, 'Se agotó el contador exacto de versiones de política.', 'POLICY_VERSION');
  policy.version += 1;
  return { ...state, revision: state.revision + 1, policyRevision: (state.policyRevision ?? 0) + 1, policy, audit: [...state.audit, auditEntry(state, ctx, 'POLICY_UPDATED', { previousPolicy: structuredClone(state.policy), policy: structuredClone(policy), policyRevision: (state.policyRevision ?? 0) + 1, ...(ctx.note ? { note: ctx.note } : {}) })] };
}
export function approveInvoice(state, invoiceId, context = {}) {
  validateState(state); const ctx = contextData(context), latest = latestMap(state).get(invoiceId);
  assert(latest, 'Procesa la factura antes de revisarla.', 'REVIEW_REQUIRED');
  if (latest.status === 'PAY') return state;
  assert(latest.status === 'REVIEW', 'Únicamente una factura en revisión admite aprobación.', 'REVIEW_REQUIRED');
  substantiveNote(ctx);
  const invoice = state.invoices.find(item => item.id === invoiceId);
  const reserved = reservations(state), result = evaluate(state, invoice, reserved, true);
  if (result.status === 'PAY') result.reasons = ['Revisión humana documentada y reglas actuales aprobadas. Reserva simulada registrada.'];
  if (latest.mode === 'human' && latest.status === result.status && latest.note === ctx.note && latest.actor === ctx.actor && latest.policyVersion === state.policy.version && JSON.stringify(latest.checks) === JSON.stringify(result.checks)) return state;
  const decision = newDecision(state, invoice, result, ctx, 'human', reserved);
  return { ...state, revision: state.revision + 1, decisions: [...state.decisions, decision], audit: [...state.audit, auditEntry(state, ctx, 'HUMAN_REVIEW', { invoiceId, decisionId: decision.id, status: decision.status, note: ctx.note, reasons: [...decision.reasons], policyRevision: decision.policyRevision })] };
}
export function rejectInvoice(state, invoiceId, context = {}) {
  validateState(state); const ctx = contextData(context), latest = latestMap(state).get(invoiceId);
  assert(latest, 'Procesa la factura antes de revisarla.', 'REVIEW_REQUIRED');
  if (latest.status === 'BLOCK') return state;
  assert(latest.status === 'REVIEW', 'El rechazo humano corresponde a facturas en revisión.', 'REVIEW_REQUIRED');
  substantiveNote(ctx);
  const invoice = state.invoices.find(item => item.id === invoiceId);
  const decision = newDecision(state, invoice, { status: 'BLOCK', reasons: [`Rechazo humano: ${ctx.note}`], checks: structuredClone(latest.checks), amountMinor: latest.amountMinor }, ctx, 'human');
  return { ...state, revision: state.revision + 1, decisions: [...state.decisions, decision], audit: [...state.audit, auditEntry(state, ctx, 'HUMAN_REJECTED', { invoiceId, decisionId: decision.id, note: ctx.note })] };
}
export function getMetrics(state) {
  validateState(state);
  const decisions = [...latestMap(state).values()], reserved = reservations(state);
  const pay = decisions.filter(item => item.status === 'PAY').length, block = decisions.filter(item => item.status === 'BLOCK').length, review = decisions.filter(item => item.status === 'REVIEW').length;
  const automatic = decisions.filter(item => item.mode === 'automatic' && item.status !== 'REVIEW').length;
  return { total: state.invoices.length, pending: state.invoices.length - decisions.length, pay, block, review, reservedMinor: reserved.all, reservedPeriodMinor: reserved.period, remainingBudgetMinor: Math.max(0, parseMoney(state.policy.periodBudget) - reserved.period), remainingBalanceMinor: Math.max(0, parseMoney(state.policy.availableBalance) - reserved.all), autonomyPercent: decisions.length ? Math.round(automatic * 100 / decisions.length) : 0, policyPeriod: state.policy.period };
}
