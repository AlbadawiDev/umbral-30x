/* Local, deterministic extraction for fictional invoices. No OCR or remote calls. */
const MAX_CHARS = 1_000_000;
const MAX_ROWS = 500;
const MAX_FIELD = 12_000;
const REQUIRED = ['number', 'beneficiaryId', 'beneficiaryName', 'amount', 'currency', 'dueDate', 'agreementId'];
const FIELDS = [...REQUIRED, 'description', 'sourceText', 'extractionIssues', 'id'];
const DENIED = new Set(['__proto__', 'prototype', 'constructor']);
let textSequence = 0;

function labelKey(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ALIASES = {
  number: ['number', 'numero', 'factura', 'numero factura', 'numero de factura', 'nro factura', 'invoice', 'invoice number', 'invoice no'],
  beneficiaryId: ['beneficiaryId', 'beneficiary id', 'beneficiario id', 'id beneficiario', 'id del beneficiario', 'proveedor id', 'id proveedor', 'supplier id', 'vendor id'],
  beneficiaryName: ['beneficiaryName', 'beneficiary name', 'beneficiario', 'nombre beneficiario', 'nombre del beneficiario', 'proveedor', 'nombre proveedor', 'supplier', 'supplier name', 'vendor', 'vendor name'],
  amount: ['amount', 'amount due', 'amount payable', 'monto', 'monto total', 'monto a pagar', 'importe', 'importe total', 'total', 'total due', 'total factura', 'total a pagar', 'invoice amount', 'invoice total', 'grand total', 'net payable', 'balance due'],
  currency: ['currency', 'moneda', 'divisa'],
  dueDate: ['dueDate', 'due date', 'vencimiento', 'fecha vencimiento', 'fecha de vencimiento'],
  agreementId: ['agreementId', 'agreement id', 'agreement', 'acuerdo', 'id acuerdo', 'acuerdo id', 'convenio', 'id convenio', 'convenio id', 'contrato', 'contract', 'contract id'],
  description: ['description', 'descripcion', 'concepto', 'detalle'],
};
const LABELS = new Map(Object.entries(ALIASES).flatMap(([field, aliases]) => aliases.map(alias => [labelKey(alias), field])));

function hasMonetaryCue(value) {
  const words = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /(?:\b(?:amount|total|subtotal|balance|payable|payment|pay|fee|fees|cost|price|charge|charges|tax|monto|importe|saldo|pago|valor|costo|precio|honorarios|comision|impuesto|iva)\b|[$€£¥])/.test(words);
}

function inputText(text) {
  if (typeof text !== 'string') throw new Error('El archivo debe contener texto UTF-8.');
  if (text.length > MAX_CHARS) throw new Error('El archivo supera el límite de 1.000.000 de caracteres.');
  if (text.includes('\u0000')) throw new Error('El archivo contiene datos binarios. Importa TXT, CSV o JSON de texto.');
  return text.replace(/^\uFEFF/, '');
}

function prefixFor(options, fallback = 'import') {
  const prefix = options.idPrefix === undefined ? fallback : options.idPrefix;
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(prefix)) {
    throw new Error('idPrefix debe tener de 1 a 100 caracteres: letras, números, punto, guion o guion bajo.');
  }
  return prefix;
}

function rowId(prefix, index) { return `${prefix}-${String(index + 1).padStart(4, '0')}`; }
function issueUnique(issues) { return [...new Set(issues)]; }

function canonicalAmount(value, issues) {
  // A single comma with 1–2 trailing digits is an explicit decimal separator.
  // Thousands grouping, mixed separators and rounding are never guessed.
  if (!/^(?:0|[1-9]\d*)(?:[.,]\d{1,2})?$/.test(value)) {
    issues.push('amount: formato ambiguo o inválido. Usa un decimal sin separadores de miles y hasta dos decimales.');
    return value;
  }
  const normalized = value.replace(',', '.');
  const [whole, fraction = ''] = normalized.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    issues.push('amount: debe ser positivo y estar dentro del rango exacto de centavos.');
  }
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function invoiceFromRecord(record, id, sourceText, initialIssues = []) {
  const invoice = { id };
  const issues = [...initialIssues];
  for (const field of REQUIRED.concat('description')) {
    const value = record[field];
    if (typeof value !== 'string') {
      invoice[field] = '';
      if (REQUIRED.includes(field)) issues.push(`${field}: falta un valor de texto explícito.`);
    } else if (value.length > MAX_FIELD) {
      throw new Error(`El campo ${field} supera ${MAX_FIELD} caracteres.`);
    } else {
      invoice[field] = value.trim();
      if (REQUIRED.includes(field) && !invoice[field]) issues.push(`${field}: falta un valor explícito.`);
    }
  }
  if (invoice.amount) invoice.amount = canonicalAmount(invoice.amount, issues);
  if (invoice.number && !/^[A-Za-z0-9][A-Za-z0-9 ._\/-]*$/.test(invoice.number)) issues.push('number: contiene caracteres no permitidos o invisibles. Confirma el número explícito de factura.');
  if (invoice.currency && !/^[A-Z]{3}$/.test(invoice.currency)) issues.push('currency: usa un código explícito de tres letras mayúsculas, por ejemplo USD.');
  if (invoice.dueDate && !validDate(invoice.dueDate)) issues.push('dueDate: fecha inválida o ambigua. Usa YYYY-MM-DD.');
  if (invoice.beneficiaryId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(invoice.beneficiaryId)) issues.push('beneficiaryId: identificador inválido.');
  if (invoice.agreementId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(invoice.agreementId)) issues.push('agreementId: identificador inválido.');
  invoice.sourceText = sourceText;
  invoice.extractionIssues = issueUnique(issues);
  return invoice;
}

export function parseInvoiceText(text, options = {}) {
  text = inputText(text);
  const prefix = prefixFor(options, 'text');
  const values = Object.create(null);
  const issues = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*•>]\s*)?([^:=]+?)\s*[:=]\s*(.*?)\s*$/);
    if (!match) {
      if (/\d/.test(line) || hasMonetaryCue(line)) issues.push('amount: hay una referencia numérica o monetaria sin campo interpretado. Revisa el texto completo.');
      continue;
    }
    const field = LABELS.get(labelKey(match[1]));
    if (!field) {
      // Deliberately conservative for any unknown numeric fact, even if its
      // label or amount syntax is novel. An uncertain total must not become a
      // payment because the extractor lacked that particular synonym.
      if (/\d/.test(match[2]) || hasMonetaryCue(match[1]) || hasMonetaryCue(match[2])) issues.push(`amount: campo numérico o monetario no reconocido «${match[1].trim().slice(0, 100)}». Se requiere revisión humana.`);
      continue;
    }
    if (!values[field]) values[field] = [];
    values[field].push(match[2]);
  }
  const record = Object.create(null);
  for (const [field, candidates] of Object.entries(values)) {
    const unique = [...new Set(candidates.map(value => value.trim()))];
    if (unique.length === 1) record[field] = unique[0];
    else issues.push(`${field}: se encontraron valores distintos. Se requiere revisión humana.`);
  }
  // A per-module counter protects multiple pasted messages in the same session.
  // Callers should pass a unique timestamp-based prefix for persisted imports.
  const id = rowId(prefix, textSequence++);
  return invoiceFromRecord(record, id, text, issues);
}

function csvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false, atStart = true;
  function pushField() {
    if (field.length > MAX_FIELD) throw new Error(`Una celda CSV supera ${MAX_FIELD} caracteres.`);
    row.push(field); field = ''; atStart = true; afterQuote = false;
  }
  function pushRow() {
    pushField();
    if (row.some(value => value !== '')) rows.push(row);
    if (rows.length > MAX_ROWS + 1) throw new Error(`El CSV supera el límite de ${MAX_ROWS} facturas.`);
    row = [];
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; afterQuote = true; }
      } else field += char;
    } else if (afterQuote) {
      if (char === ',') pushField();
      else if (char === '\n') pushRow();
      else if (char === '\r' && text[index + 1] === '\n') { index++; pushRow(); }
      else if (char === '\r') pushRow();
      else throw new Error('CSV inválido: hay caracteres después del cierre de comillas.');
    } else if (char === '"') {
      if (!atStart) throw new Error('CSV inválido: las comillas deben comenzar al inicio de la celda.');
      quoted = true; atStart = false;
    } else if (char === ',') pushField();
    else if (char === '\n') pushRow();
    else if (char === '\r' && text[index + 1] === '\n') { index++; pushRow(); }
    else if (char === '\r') pushRow();
    else { field += char; atStart = false; }
    if (field.length > MAX_FIELD) throw new Error(`Una celda CSV supera ${MAX_FIELD} caracteres.`);
  }
  if (quoted) throw new Error('CSV inválido: faltan comillas de cierre.');
  if (field !== '' || row.length || afterQuote) pushRow();
  return rows;
}

export function parseInvoiceCSV(text, options = {}) {
  text = inputText(text);
  const rows = csvRows(text);
  if (rows.length < 2) throw new Error('El CSV necesita una cabecera y al menos una factura.');
  const headers = rows.shift().map(value => {
    if (DENIED.has(value.trim())) throw new Error('El CSV contiene una clave de prototipo no permitida.');
    return LABELS.get(labelKey(value)) || (FIELDS.includes(value.trim()) ? value.trim() : null);
  });
  const known = headers.filter(Boolean);
  if (!known.length) throw new Error('La cabecera CSV no contiene campos de factura reconocidos.');
  if (new Set(known).size !== known.length) throw new Error('La cabecera CSV contiene campos duplicados o alias equivalentes.');
  const prefix = prefixFor(options);
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`La fila ${index + 2} no coincide con la cabecera CSV.`);
    const record = Object.create(null);
    const issues = [];
    values.forEach((value, column) => {
      const field = headers[column];
      if (field && !['id', 'sourceText', 'extractionIssues'].includes(field)) record[field] = value;
      if (field === 'extractionIssues' && value.trim()) {
        try {
          const inherited = JSON.parse(value);
          if (!Array.isArray(inherited) || inherited.some(issue => typeof issue !== 'string')) throw new Error();
          issues.push(...inherited);
        } catch { issues.push('extractionIssues: la fila contiene advertencias previas sin formato de lista válido.'); }
      }
    });
    if (headers.some(header => header === null)) issues.push('CSV: contiene columnas desconocidas que no se interpretaron.');
    return invoiceFromRecord(record, rowId(prefix, index), JSON.stringify(values), issues);
  });
}

function rejectPrototypeKeys(value, depth = 0) {
  if (depth > 20) throw new Error('JSON demasiado anidado.');
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (DENIED.has(key)) throw new Error(`JSON contiene una clave no permitida: ${key}.`);
    rejectPrototypeKeys(value[key], depth + 1);
  }
}

function rejectDuplicateJSONKeys(text) {
  // JSON.parse has already checked syntax. Inspect object key tokens before a
  // later duplicate can silently replace an earlier amount, vendor or date.
  const stack = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '{') stack.push(new Set());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = index++;
      for (; index < text.length; index++) {
        if (text[index] === '\\') index++;
        else if (text[index] === '"') break;
      }
      let next = index + 1;
      while (/\s/.test(text[next] || '') && next < text.length) next++;
      if (text[next] === ':' && stack.at(-1) instanceof Set) {
        const key = JSON.parse(text.slice(start, index + 1));
        if (stack.at(-1).has(key)) throw new Error(`JSON ambiguo: clave repetida ${key}.`);
        stack.at(-1).add(key);
      }
    }
  }
}

export function parseInvoiceJSON(text, options = {}) {
  text = inputText(text);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('JSON inválido. Revisa las comillas, comas y corchetes.'); }
  rejectDuplicateJSONKeys(text);
  rejectPrototypeKeys(parsed);
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray(parsed.invoices) ? parsed.invoices : [parsed];
  if (!rows.length || rows.length > MAX_ROWS) throw new Error(`El JSON necesita entre 1 y ${MAX_ROWS} facturas.`);
  const prefix = prefixFor(options);
  return rows.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`La factura JSON ${index + 1} debe ser un objeto.`);
    const unknown = Object.keys(record).filter(key => !FIELDS.includes(key));
    if (unknown.length) throw new Error(`La factura JSON ${index + 1} contiene campos desconocidos: ${unknown.join(', ')}.`);
    if (record.extractionIssues !== undefined && (!Array.isArray(record.extractionIssues) || record.extractionIssues.some(issue => typeof issue !== 'string' || issue.length > MAX_FIELD))) throw new Error('extractionIssues debe ser una lista de textos.');
    if (record.sourceText !== undefined && (typeof record.sourceText !== 'string' || record.sourceText.length > MAX_FIELD)) throw new Error('sourceText debe ser texto de hasta 12.000 caracteres.');
    return invoiceFromRecord(record, rowId(prefix, index), record.sourceText ?? JSON.stringify(record), record.extractionIssues ?? []);
  });
}

export function parseInvoiceFile(text, filename, options = {}) {
  if (typeof filename !== 'string') throw new Error('Falta el nombre del archivo.');
  const extension = filename.toLowerCase().split('.').pop();
  if (extension === 'txt') return [parseInvoiceText(text, options)];
  if (extension === 'csv') return parseInvoiceCSV(text, options);
  if (extension === 'json') return parseInvoiceJSON(text, options);
  if (['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'bmp'].includes(extension)) throw new Error('PDF e imágenes no están soportados. Este prototipo no hace OCR. Copia el texto o importa TXT, CSV o JSON.');
  throw new Error('Formato no soportado. Importa un archivo TXT, CSV o JSON.');
}

function demo(id, number, beneficiaryId, beneficiaryName, amount, agreementId, overrides = {}) {
  return {
    id, number, beneficiaryId, beneficiaryName, amount, currency: 'USD', dueDate: '2026-10-18', agreementId,
    description: 'Caso de prueba ficticio. No representa una obligación ni una transferencia real.',
    sourceText: 'Datos sintéticos creados para la demostración del hackathon. Todas las entidades son ficticias.',
    extractionIssues: [], ...overrides,
  };
}

export const DEMO_INVOICES = Object.freeze([
  demo('demo-001', 'NST-001', 'norte', 'Norte Studio (ficticio)', '400.00', 'DES-01'),
  demo('demo-002', 'NST-001', 'norte', 'Norte Studio (ficticio)', '400.00', 'DES-01'),
  demo('demo-003', 'NVO-001', 'nuevo', 'Lirio Laboratorio (ficticio)', '150.00', 'NEW-01'),
  demo('demo-004', 'NST-002', 'norte', 'Norte Studio (ficticio)', '200.00', 'DES-99'),
  demo('demo-005', 'AND-001', 'andina', 'Andina Cloud (ficticio)', '850.00', 'CLOUD-01'),
  demo('demo-006', 'ORI-001', 'oriente', 'Taller Oriente (ficticio)', '2100.00', 'OPS-01'),
  demo('demo-007', 'BRI-001', 'brisa', 'Brisa Contenido (ficticio)', '200.00', 'COPY-01', { currency: 'EUR' }),
  demo('demo-008', 'BRI-002', 'brisa', 'Brisa Contenido (ficticio)', '', 'COPY-01', { extractionIssues: ['amount: el mensaje contiene 120.00 y 180.00. Se requiere confirmar el monto.'] }),
  demo('demo-009', 'AND-002', 'andina', 'Andina Cloud (ficticio)', '220.00', 'CLOUD-01', { dueDate: '2026-02-30', extractionIssues: ['dueDate: la fecha no existe.'] }),
  demo('demo-010', 'NST-003', 'norte', 'Norte Studio (ficticio)', '450.00', 'DES-01'),
  demo('demo-011', 'BRI-003', 'brisa', 'Brisa Contenido (ficticio)', '450.00', 'COPY-01'),
  demo('demo-012', 'AND-003', 'andina', 'Andina Cloud (ficticio)', '500.00', 'CLOUD-01'),
  demo('demo-013', 'ORI-002', 'oriente', 'Taller Oriente (ficticio)', '500.00', 'OPS-01'),
  demo('demo-014', 'ORI-003', 'oriente', 'Taller Oriente (ficticio)', '500.00', 'OPS-01'),
  demo('demo-015', 'ORI-004', 'oriente', 'Taller Oriente (ficticio)', '300.00', 'OPS-01'),
  demo('demo-016', 'ORI-005', 'oriente', 'Taller Oriente (ficticio)', '800.00', 'OPS-01'),
].map(invoice => Object.freeze({ ...invoice, extractionIssues: Object.freeze([...invoice.extractionIssues]) })));

export const DEMO_EXPECTATIONS = Object.freeze({
  'demo-001': 'PAY', 'demo-002': 'BLOCK', 'demo-003': 'REVIEW', 'demo-004': 'BLOCK',
  'demo-005': 'REVIEW', 'demo-006': 'BLOCK', 'demo-007': 'BLOCK', 'demo-008': 'REVIEW',
  'demo-009': 'REVIEW', 'demo-010': 'PAY', 'demo-011': 'PAY', 'demo-012': 'PAY',
  'demo-013': 'PAY', 'demo-014': 'PAY', 'demo-015': 'BLOCK', 'demo-016': 'BLOCK',
});
