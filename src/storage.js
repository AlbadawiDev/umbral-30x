import {getMetrics} from './domain.js';
export const STORAGE_KEY = 'umbral-30x-v1';
const LEASE_KEY = `${STORAGE_KEY}:lease`;
const MAX_BYTES = 5_000_000;
const badKeys = new Set(['__proto__', 'constructor', 'prototype']);
export class StorageConflict extends Error { constructor(message = 'Otra pestaña cambió los datos. Se cargó la versión reciente. Repite tu acción.') { super(message); this.name = 'StorageConflict'; } }
export class InvalidStorage extends Error { constructor(message = 'Los datos locales no tienen un formato válido.') { super(message); this.name = 'InvalidStorage'; } }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function safeTree(value, depth = 0) {
  if (depth > 16) return false;
  if (value === null || typeof value !== 'object') return typeof value !== 'number' || Number.isFinite(value);
  return Object.entries(value).every(([key, item]) => !badKeys.has(key) && safeTree(item, depth + 1));
}
export function validateState(value) {
  if (!plain(value) || !safeTree(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
  if (!plain(value.policy) || !Array.isArray(value.invoices) || !Array.isArray(value.decisions) || !Array.isArray(value.audit)) return false;
  const p = value.policy;
  if (!Number.isSafeInteger(p.version) || p.version < 1 || !['currency', 'autoLimit', 'paymentLimit', 'periodBudget', 'availableBalance', 'period'].every(k => typeof p[k] === 'string')) return false;
  if (!Array.isArray(p.beneficiaries) || p.beneficiaries.length > 5000 || value.invoices.length > 10000 || value.decisions.length > 50000 || value.audit.length > 100000) return false;
  if (!p.beneficiaries.every(b => plain(b) && typeof b.id === 'string' && typeof b.name === 'string' && typeof b.enabled === 'boolean' && Array.isArray(b.agreements) && b.agreements.every(a => plain(a) && ['id', 'maxAmount', 'currency'].every(k => typeof a[k] === 'string')))) return false;
  const invoiceIds = new Set();
  if (!value.invoices.every(i => {
    if (!plain(i) || !['id', 'number', 'beneficiaryId', 'beneficiaryName', 'amount', 'currency', 'dueDate', 'agreementId', 'description', 'sourceText'].every(k => typeof i[k] === 'string') || !i.id || invoiceIds.has(i.id)) return false;
    invoiceIds.add(i.id);
    return i.extractionIssues === undefined || (Array.isArray(i.extractionIssues) && i.extractionIssues.every(x => typeof x === 'string'));
  })) return false;
  const decisionIds = new Set();
  const decisionsValid = value.decisions.every(d => {
    if (!plain(d) || typeof d.id !== 'string' || decisionIds.has(d.id) || !invoiceIds.has(d.invoiceId) || !['PAY', 'BLOCK', 'REVIEW'].includes(d.status)) return false;
    decisionIds.add(d.id);
    return Array.isArray(d.reasons) && d.reasons.every(x => typeof x === 'string') && Array.isArray(d.checks) && d.checks.every(c => plain(c) && typeof c.ruleId === 'string' && typeof c.label === 'string' && typeof c.passed === 'boolean' && typeof c.reason === 'string') && (d.amountMinor === null || Number.isSafeInteger(d.amountMinor)) && typeof d.at === 'string' && typeof d.actor === 'string' && ['automatic', 'human'].includes(d.mode);
  });
  if (!decisionsValid || !value.audit.every(event => plain(event) && typeof event.id === 'string' && typeof event.at === 'string' && typeof event.actor === 'string' && typeof event.type === 'string' && Number.isSafeInteger(event.revision))) return false;
  try { getMetrics(value); } catch { return false; }
  return true;
}
export function readStoredState(storage = globalThis.localStorage) {
  let raw;
  try { raw = storage.getItem(STORAGE_KEY); } catch { throw new InvalidStorage('El navegador no permite guardar datos locales.'); }
  if (raw === null) return null;
  if (raw.length > MAX_BYTES) throw new InvalidStorage('Los datos locales superan el tamaño admitido.');
  let value;
  try { value = JSON.parse(raw); } catch { throw new InvalidStorage(); }
  if (!validateState(value)) throw new InvalidStorage();
  return value;
}
export function commitState(expected, next, storage = globalThis.localStorage) {
  if (!validateState(next)) throw new InvalidStorage('El resultado no tiene un formato válido y no se guardó.');
  const current = readStoredState(storage);
  if ((current?.revision ?? 0) !== expected.revision || (current && JSON.stringify(current) !== JSON.stringify(expected))) throw new StorageConflict();
  if (next.revision < expected.revision || (next.revision === expected.revision && JSON.stringify(next) !== JSON.stringify(expected))) throw new StorageConflict('Cada cambio debe incrementar la revisión local.');
  const encoded = JSON.stringify(next);
  if (encoded.length > MAX_BYTES) throw new InvalidStorage('La demostración alcanzó el límite de almacenamiento local. Exporta la bitácora.');
  try { storage.setItem(STORAGE_KEY, encoded); } catch { throw new InvalidStorage('No quedó espacio para guardar la operación. No se aplicó el cambio.'); }
  return next;
}
export async function mutateStoredState(expected, mutate, storage = globalThis.localStorage) {
  const task = () => {
    const current = readStoredState(storage);
    if ((current?.revision ?? 0) !== expected.revision || (current && JSON.stringify(current) !== JSON.stringify(expected))) throw new StorageConflict();
    const next = mutate(current ?? expected);
    if (next && typeof next.then === 'function') throw new TypeError('La operación debe ser sincrónica.');
    return commitState(expected, next, storage);
  };
  if (globalThis.navigator?.locks?.request && storage === globalThis.localStorage) return navigator.locks.request(STORAGE_KEY, {mode: 'exclusive'}, task);
  const owner = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  let lease;
  try { lease = JSON.parse(storage.getItem(LEASE_KEY) || 'null'); } catch { lease = null; }
  if (lease && lease.expires > Date.now()) throw new StorageConflict('Otra pestaña está guardando una operación. Espera un momento.');
  storage.setItem(LEASE_KEY, JSON.stringify({owner, expires: Date.now() + 2500}));
  try {
    if (JSON.parse(storage.getItem(LEASE_KEY) || 'null')?.owner !== owner) throw new StorageConflict();
    return task();
  } finally {
    try { if (JSON.parse(storage.getItem(LEASE_KEY) || 'null')?.owner === owner) storage.removeItem(LEASE_KEY); } catch { /* lease expires */ }
  }
}
