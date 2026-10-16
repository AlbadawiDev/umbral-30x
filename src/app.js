import { DEFAULT_POLICY, createState, addInvoices, processInvoices, updatePolicy, approveInvoice, rejectInvoice, getMetrics, getLatestDecision, formatMoney, parseMoney } from './domain.js';
import { parseInvoiceText, parseInvoiceFile, DEMO_INVOICES, DEMO_EXPECTATIONS } from './import.js';
import { STORAGE_KEY, readStoredState, mutateStoredState, StorageConflict } from './storage.js';

const $ = (selector, base = document) => base.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clone = value => JSON.parse(JSON.stringify(value));
const labels = {PAY:'Pagar (simulado)', BLOCK:'Frenar', REVIEW:'Revisión humana', PENDING:'Pendiente'};
const shortLabels = {PAY:'Pagar', BLOCK:'Frenar', REVIEW:'Revisión', PENDING:'Pendiente'};
const tabNames = {operations:'Operación', rules:'Reglas', audit:'Bitácora', tests:'Pruebas'};
const scenarioLabels = {
  'demo-001':'Factura válida dentro del umbral', 'demo-002':'Misma factura y beneficiario repetidos',
  'demo-003':'Beneficiario aún no autorizado', 'demo-004':'Convenio ajeno al beneficiario',
  'demo-005':'Monto sobre el umbral automático', 'demo-006':'Monto sobre el límite absoluto',
  'demo-007':'Moneda diferente de USD', 'demo-008':'Dos montos contradictorios en la entrada',
  'demo-009':'Fecha de vencimiento inexistente', 'demo-010':'Segunda factura válida de diseño',
  'demo-011':'Factura válida de contenido', 'demo-012':'Exactamente en el umbral automático',
  'demo-013':'Reserva secuencial de operaciones', 'demo-014':'Reserva con saldo restante suficiente',
  'demo-015':'Saldo insuficiente tras otras reservas', 'demo-016':'Presupuesto y saldo insuficientes'
};
const icons = {
 operations:'<rect x="3" y="3" width="6" height="7" rx="1"/><rect x="13" y="3" width="6" height="4" rx="1"/><rect x="3" y="14" width="6" height="5" rx="1"/><rect x="13" y="11" width="6" height="8" rx="1"/>',
 rules:'<path d="M4 6h14M4 16h14M8 3v6M14 13v6"/><circle cx="8" cy="6" r="2"/><circle cx="14" cy="16" r="2"/>',
 audit:'<rect x="5" y="3" width="13" height="17" rx="2"/><path d="M8 8h7M8 12h7M8 16h4M3 6h3M3 10h3M3 14h3"/>',
 tests:'<path d="M8 3v6l-4 8a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-4-8V3M6 3h10M7 13h10"/>',
 plus:'<path d="M11 4v14M4 11h14"/>',
 play:'<path d="m8 4 10 7-10 7Z"/>',
 search:'<circle cx="9" cy="9" r="6"/><path d="m14 14 5 5"/>',
 download:'<path d="M11 3v11m-4-4 4 4 4-4M4 15v5h14v-5"/>',
 shield:'<path d="m11 2 8 3v6c0 5-8 9-8 9s-8-4-8-9V5Z"/><path d="m7 11 3 3 5-6"/>'
};
const svg = name => `<svg viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.operations}</svg>`;
let state = createState(DEFAULT_POLICY);
let storageError = '';
try { state = readStoredState() ?? state; } catch (error) { storageError = error.message; }
let tab = 'operations';
let filter = 'ALL';
let search = '';
let selectedId = state.invoices[0]?.id ?? null;
let busy = false;
let policyDraft = null;
let testResult = null;
let toastTimer;
const context = note => ({actor:'Daniel · demostración local', now:new Date().toISOString(), ...(note ? {note} : {})});

function toast(message, error = false) {
  const region = $('#toast-region');
  region.replaceChildren();
  const item = document.createElement('div');
  item.className = `toast${error ? ' error' : ''}`;
  item.textContent = message;
  region.append(item);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => region.replaceChildren(), 6500);
}
function dateLabel(iso, includeTime = false) {
  if (!iso) return 'Sin fecha';
  const date = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('es-VE', {day:'2-digit',month:'short', ...(includeTime ? {hour:'2-digit',minute:'2-digit'} : {}), timeZone:'America/Caracas'}).format(date).replace('.', '');
}
function moneyValue(invoice) { try { return formatMoney(parseMoney(invoice.amount), invoice.currency || 'USD'); } catch { return invoice.amount ? `${invoice.amount} ${invoice.currency}` : 'Monto pendiente'; } }
function statusOf(invoice) { return getLatestDecision(state, invoice.id)?.status ?? 'PENDING'; }
function badge(status, short = false) { return `<span class="status ${esc(status)}"><i class="status-dot" aria-hidden="true"></i>${esc((short ? shortLabels : labels)[status] || status)}</span>`; }
function count(status) { return state.invoices.filter(i => statusOf(i) === status).length; }
function userInitials(name) { return name.split(/\s+/).filter(Boolean).slice(0,2).map(x => x[0]).join('').toUpperCase() || 'FA'; }
function metrics() { try { return getMetrics(state); } catch { return {total:state.invoices.length,pending:count('PENDING'),pay:count('PAY'),block:count('BLOCK'),review:count('REVIEW'),reservedMinor:0,remainingBudgetMinor:0,remainingBalanceMinor:0,autonomyPercent:0}; } }

async function mutate(fn, success) {
  if (busy) return false;
  if (storageError) { toast('Restablece los datos locales antes de realizar cambios.', true); return false; }
  busy = true;
  try {
    state = await mutateStoredState(state, fn);
    render();
    if (success) toast(success);
    return true;
  } catch (error) {
    if (error instanceof StorageConflict) {
      try { state = readStoredState() ?? createState(DEFAULT_POLICY); } catch (storageIssue) { storageError = storageIssue.message; }
      policyDraft = null;
      render();
    }
    toast(error.message || 'No se aplicó el cambio.', true);
    return false;
  } finally { busy = false; }
}

function shell() {
  const m = metrics();
  return `<div class="shell"><aside class="sidebar" aria-label="Navegación principal"><a class="brand" href="#operacion" aria-label="Umbral, inicio"><span class="brand-mark" aria-hidden="true">u</span><span class="brand-name">umbral</span></a><div class="brand-caption">Decisiones con criterio</div><div class="workspace-switch"><span class="workspace-symbol" aria-hidden="true">m</span><div><div class="workspace-name">Mar Abierto Labs</div><div class="workspace-kind">Organización ficticia</div></div></div><p class="nav-label">ESPACIO DE TRABAJO</p><nav class="nav">${Object.entries(tabNames).map(([key,label]) => `<button class="nav-button ${tab === key ? 'active' : ''}" data-tab="${key}" ${tab === key ? 'aria-current="page"' : ''}>${svg(key)}<span>${label}</span>${key === 'operations' && m.pending ? `<span class="nav-count">${m.pending}</span>` : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="safe-box"><div class="safe-title"><span class="tiny-dot"></span> Un entorno seguro para probar</div><p>Datos en este navegador.<br>Sin conexiones bancarias.<br>Sin transferencias de dinero.</p></div><div class="profile"><span class="avatar">DA</span><div><div class="profile-name">Daniel Albadawi</div><div class="profile-role">Albadawi Lab · Hackathon 30X</div></div></div></div></aside><div class="main"><header class="topbar"><div class="breadcrumb"><span>Workspace</span><span class="chevron">/</span><strong>${tabNames[tab]}</strong></div><div class="topbar-right"><span class="local-badge"><span class="tiny-dot"></span> Demo local</span><time class="date-label" datetime="2026-10-16">16 oct 2026 · referencia</time></div></header><main class="content" id="main-content" tabindex="-1">${storageError ? `<div class="notice" role="alert">${esc(storageError)} <button class="button small secondary" data-action="reset">Restablecer datos</button></div>` : ''}${tab === 'operations' ? operations() : tab === 'rules' ? rules() : tab === 'audit' ? audit() : tests()}<footer class="bottom-note"><span>Umbral · Proyecto de Daniel Albadawi · Datos ficticios</span><span>Decisiones trazables. Dinero siempre simulado.</span></footer></main></div></div>`;
}

function demoStrip() { return '<div class="demo-strip"><div class="strip-left"><span class="strip-icon" aria-hidden="true">◈</span><span><strong>Demostración · Datos ficticios · No mueve dinero.</strong> Cada pago representa una reserva simulada.</span></div><span class="strip-right">100 % local · Sin claves ni servicios externos</span></div>'; }

function operations() {
  const m = metrics();
  return `<section class="section-heading"><div class="hero"><div class="eyebrow">CONTROL FINANCIERO, CON CONTEXTO</div><h1>Cada factura,<br>una decisión defendible.</h1><p>Umbral valida, decide y explica. Tu equipo interviene cuando hace falta criterio humano.</p></div><div class="heading-actions"><button class="button secondary" data-action="load-demo">Cargar ejemplos</button><button class="button primary" data-action="open-import">${svg('plus')} Importar factura</button></div></section>${demoStrip()}<div class="metrics" aria-label="Resumen de decisiones"><div class="metric"><div class="metric-label">Facturas recibidas <span aria-hidden="true">↗</span></div><div class="metric-value">${m.total}<span>facturas</span></div><div class="metric-sub">${m.pending} pendientes de procesar</div></div><div class="metric"><div class="metric-label">Decisiones autónomas</div><div class="metric-value">${Math.round(m.autonomyPercent || 0)}<span>%</span></div><div class="metric-sub"><span class="jade-text">${m.pay + m.block} resueltas</span> · ${m.review} en revisión</div><div class="sparkline" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div></div><div class="metric"><div class="metric-label">Reservas simuladas</div><div class="metric-value">${esc(formatMoney(m.reservedMinor))}</div><div class="metric-sub">${m.pay} facturas · sin mover dinero</div></div><div class="metric"><div class="metric-label">Presupuesto disponible</div><div class="metric-value">${esc(formatMoney(m.remainingBudgetMinor))}</div><div class="metric-sub">Saldo disponible: ${esc(formatMoney(m.remainingBalanceMinor))}</div></div></div><div class="rule-band"><div class="rule-lead"><strong>Tu política, en acción</strong><span>Versión ${state.policy.version} · ${esc(state.policy.period)}</span></div><div class="rule-flow"><div class="rule-step"><span class="step-num">1</span><div><strong>Datos completos</strong><span>Sin ambigüedades</span></div></div><span class="flow-arrow">→</span><div class="rule-step"><span class="step-num">2</span><div><strong>Beneficiario + convenio</strong><span>Identidad autorizada</span></div></div><span class="flow-arrow">→</span><div class="rule-step"><span class="step-num">3</span><div><strong>Hasta ${esc(state.policy.autoLimit)} USD</strong><span>Dentro de los límites</span></div></div><span class="flow-arrow">→</span><div class="rule-step"><span class="step-num">4</span><div><strong>Reserva + trazabilidad</strong><span>Decisión explicada</span></div></div></div><button class="rule-link" data-tab="rules">Ver reglas ↗</button></div><div class="operations-grid">${workbench()}${drawer()}</div>`;
}

function workbench() {
  const filtered = state.invoices.filter(invoice => (filter === 'ALL' || statusOf(invoice) === filter) && (!search || [invoice.number,invoice.beneficiaryName,invoice.beneficiaryId,invoice.description,invoice.id].join(' ').toLocaleLowerCase('es').includes(search.toLocaleLowerCase('es'))));
  return `<section class="panel" aria-labelledby="workbench-title"><div class="panel-head"><div><h2 class="panel-title" id="workbench-title">Bandeja de facturas <span class="count-pill">${state.invoices.length}</span></h2><p class="panel-subtitle">Una entrada. Todas las comprobaciones. Una decisión.</p></div><button class="button small primary" data-action="process" ${!count('PENDING') ? 'disabled' : ''}>${svg('play')} Procesar ${count('PENDING') || ''}</button></div><div class="filter-row"><div class="segmented" aria-label="Filtrar por decisión">${[['ALL','Todas'],['PENDING','Pendientes'],['PAY','Pagar'],['REVIEW','Revisar'],['BLOCK','Frenar']].map(([key,label]) => `<button class="filter-button ${filter === key ? 'active' : ''}" data-filter="${key}" aria-pressed="${filter === key}">${label}<span class="mini-count">${key === 'ALL' ? state.invoices.length : count(key)}</span></button>`).join('')}</div><div class="search">${svg('search')}<label class="visually-hidden" for="invoice-search">Buscar facturas</label><input id="invoice-search" type="search" placeholder="Buscar factura" value="${esc(search)}" autocomplete="off"></div></div><div class="table-wrap"><table><thead><tr><th>BENEFICIARIO / FACTURA</th><th>IMPORTE</th><th>DECISIÓN</th><th class="date-col">VENCE</th><th><span class="visually-hidden">Detalle</span></th></tr></thead><tbody>${filtered.length ? filtered.map(invoice => `<tr class="invoice-row ${selectedId === invoice.id ? 'selected' : ''}" data-invoice="${esc(invoice.id)}"><td><button class="table-access" data-invoice="${esc(invoice.id)}" aria-label="Ver factura ${esc(invoice.number || 'sin número')}, ${esc(invoice.beneficiaryName || 'beneficiario pendiente')}"><span class="vendor-cell"><span class="vendor-avatar" aria-hidden="true">${esc(userInitials(invoice.beneficiaryName))}</span><span><span class="vendor-name">${esc(invoice.beneficiaryName || 'Beneficiario sin identificar')}</span><span class="invoice-number" style="display:block">${esc(invoice.number || 'Sin número')} · ${esc(invoice.agreementId || 'Sin convenio')}</span></span></span></button></td><td class="money">${esc(moneyValue(invoice))}</td><td>${badge(statusOf(invoice), true)}</td><td class="date-cell">${esc(dateLabel(invoice.dueDate))}</td><td class="row-arrow" aria-hidden="true">↗</td></tr>`).join('') : `<tr><td colspan="5"><div class="empty-table"><h3>${state.invoices.length ? 'No hay coincidencias.' : 'El criterio empieza con una factura.'}</h3><p>${state.invoices.length ? 'Prueba otra búsqueda o un filtro distinto.' : 'Carga los ejemplos ficticios para ver las decisiones o importa tu propio caso de prueba.'}</p>${!state.invoices.length ? '<button class="button primary" data-action="load-demo">Explorar con ejemplos ↗</button>' : ''}</div></td></tr>`}</tbody></table></div><div class="panel-foot"><span>${filtered.length} de ${state.invoices.length} facturas · ${esc(state.policy.period)}</span><span><span class="tiny-dot"></span> Guardado local · rev. ${state.revision}</span></div></section>`;
}

function drawer() {
  const invoice = state.invoices.find(i => i.id === selectedId);
  if (!invoice) return '<aside class="panel drawer" aria-label="Detalle de la decisión"><div class="drawer-head"><span class="eyebrow">DETALLE DE LA DECISIÓN</span><span class="chevron">↗</span></div><div class="empty-detail"><div class="empty-symbol">u</div><h3>El porqué importa.</h3><p>Selecciona una factura para revisar cada comprobación, su contexto y la trazabilidad de la decisión.</p></div><div class="privacy-foot">Sin caja negra. Las reglas son explícitas y cada decisión conserva su evidencia.</div></aside>';
  const decision = getLatestDecision(state, invoice.id);
  const status = decision?.status || 'PENDING';
  return `<aside class="panel drawer" aria-labelledby="decision-title"><div class="drawer-head"><span class="eyebrow" id="decision-title">DETALLE DE LA DECISIÓN</span><button class="icon-button" data-action="close-detail" aria-label="Cerrar detalle">×</button></div><div class="drawer-body"><div class="drawer-summary"><div class="drawer-vendor"><span class="vendor-avatar">${esc(userInitials(invoice.beneficiaryName))}</span><div><strong>${esc(invoice.beneficiaryName || 'Beneficiario pendiente')}</strong><span>${esc(invoice.number || 'Factura sin número')}</span></div></div><div class="drawer-amount">${esc(moneyValue(invoice))}</div><div class="drawer-meta">Vence ${esc(dateLabel(invoice.dueDate))} · ${esc(invoice.agreementId || 'Convenio pendiente')}</div><div class="decision-result ${status}"><div class="result-top"><span aria-hidden="true">${status === 'PAY' ? '✓' : status === 'BLOCK' ? '⊘' : status === 'REVIEW' ? '◷' : '○'}</span>${esc(labels[status])}</div><div class="result-note">${decision ? esc(decision.reasons.join(' ')) : 'Pendiente de validar. Procesa la bandeja para aplicar la política vigente.'}</div></div>${status === 'PAY' ? '<p class="human-notice">Reserva simulada registrada. No se ejecutó ningún pago.</p>' : ''}</div><div class="drawer-checks"><div class="checks-heading">${decision ? 'COMPROBACIONES REALIZADAS' : 'ANTES DE DECIDIR'}</div>${decision ? decision.checks.map(check => `<div class="check ${check.passed ? '' : 'failed'}"><span class="check-icon" aria-hidden="true">${check.passed ? '✓' : '!'}</span><div><strong>${esc(check.label)}</strong><p>${esc(check.reason)}</p></div></div>`).join('') : '<p class="human-notice">Se comprobarán los datos, beneficiario, convenio, moneda, duplicados, límites, presupuesto y saldo disponible.</p>'}</div><div class="drawer-tail">${status === 'REVIEW' ? `<div class="drawer-divider"></div><label class="review-label" for="review-note">Criterio de la revisión humana</label><textarea class="review-text" id="review-note" placeholder="Explica la revisión y su evidencia. Mínimo 12 caracteres." rows="3"></textarea><p class="human-notice">La aprobación vuelve a comprobar las reglas vigentes. Una nota no corrige datos ausentes ni permite saltar un límite.</p><div class="review-actions"><button class="button small secondary" data-action="reject" data-id="${esc(invoice.id)}">Rechazar</button><button class="button small primary" data-action="approve" data-id="${esc(invoice.id)}">Aprobar simulación</button></div>` : ''}<details class="source-disclosure"><summary>Ver entrada original y datos</summary><pre class="source-text">${esc(invoice.sourceText || invoice.description || 'Importación estructurada sin texto original.')}</pre>${invoice.extractionIssues?.length ? `<p class="human-notice">Incidencias: ${esc(invoice.extractionIssues.join(' · '))}</p>` : ''}<pre class="source-text">${esc(JSON.stringify({id:invoice.id,beneficiaryId:invoice.beneficiaryId,agreementId:invoice.agreementId,amount:invoice.amount,currency:invoice.currency,dueDate:invoice.dueDate}, null, 2))}</pre></details>${decision ? `<div class="decision-meta"><span>Reglas v${esc(decision.policyVersion)} · ${decision.mode === 'human' ? 'Revisión humana' : 'Motor de reglas'}</span><span>${esc(dateLabel(decision.at, true))}</span></div><button class="trace-link" data-tab="audit">Consultar bitácora ↗</button>` : ''}</div></div></aside>`;
}

function policyField(key,label,hint,type='text') { return `<div><label class="field-label" for="policy-${key}">${label}</label><input id="policy-${key}" name="${key}" type="${type}" value="${esc(policyDraft[key])}" ${key === 'currency' ? 'readonly' : ''} ${['autoLimit','paymentLimit','periodBudget','availableBalance'].includes(key) ? 'inputmode="decimal" pattern="[0-9]+([.][0-9]{1,2})?"' : ''} required><span class="field-hint">${hint}</span></div>`; }
function rules() {
  if (!policyDraft) policyDraft = clone(state.policy);
  return `<section class="section-heading"><div class="hero"><div class="eyebrow">EL CRITERIO ES TUYO</div><h1>Reglas claras.<br>Autonomía con límites.</h1><p>Cada cambio conserva su versión. Las decisiones anteriores mantienen la política con la que se tomaron.</p></div><div class="heading-actions"><span class="local-badge">Política v${state.policy.version}</span></div></section>${demoStrip()}<div class="settings-layout"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Política de la organización</h2><p class="panel-subtitle">Todas las cantidades se calculan en centavos exactos.</p></div></div><form id="policy-form" class="settings-body"><div class="form-grid">${policyField('autoLimit','Umbral automático (USD)','Por encima, exige revisión humana.')}${policyField('paymentLimit','Límite por factura (USD)','Una factura por encima se frena.')}${policyField('periodBudget','Presupuesto del período (USD)','Se descuenta cada reserva del período.')}${policyField('availableBalance','Saldo simulado inicial (USD)','Se descuenta toda reserva registrada.')}${policyField('period','Período de la política','Una fecha ajena al período exige revisión.','month')}${policyField('currency','Moneda admitida','Otras monedas se frenan. No hay conversión.')}</div><div class="settings-heading"><h3>Beneficiarios y convenios</h3><button class="button small secondary" type="button" data-action="add-supplier">+ Agregar beneficiario</button></div><p class="compact-note">El ID identifica al beneficiario. Cada convenio tiene su propio límite. Usa nombres y datos ficticios.</p><div id="supplier-fields">${policyDraft.beneficiaries.length ? policyDraft.beneficiaries.map((supplier,index) => supplierFields(supplier,index)).join('') : '<p class="settings-empty">Sin beneficiarios autorizados.</p>'}</div><div class="settings-save"><p class="compact-note">Guardar crea la versión ${state.policy.version + 1}.<br>Las revisiones humanas usarán las reglas nuevas.</p><button class="button primary" type="submit">Guardar política ↗</button></div><p class="form-error" id="policy-error" role="alert"></p></form></section><aside class="panel help-panel"><span class="eyebrow">CÓMO DECIDE UMBRAL</span><h3>Automático cuando es claro.<br>Humano cuando importa.</h3><ol><li>Datos completos, coherentes y dentro del período.</li><li>Beneficiario habilitado y convenio coincidente.</li><li>Sin duplicados. Misma moneda. Límites respetados.</li><li>Saldo y presupuesto suficientes antes de reservar.</li></ol><p>Las facturas por encima del umbral automático se revisan. Los límites duros no se saltan con una aprobación.</p><div class="drawer-divider"></div><p>Una decisión «Pagar» representa una reserva local. Este prototipo no tiene acceso a cuentas ni envía dinero.</p></aside></div>`;
}
function supplierFields(supplier,index) { return `<div class="supplier-card" data-supplier="${index}"><div class="supplier-head"><div><label class="field-label" for="supplier-id-${index}">ID</label><input id="supplier-id-${index}" data-supplier-key="id" value="${esc(supplier.id)}" required></div><div><label class="field-label" for="supplier-name-${index}">Beneficiario ficticio</label><input id="supplier-name-${index}" data-supplier-key="name" value="${esc(supplier.name)}" required></div><label class="enabled-label" title="Beneficiario habilitado"><span class="visually-hidden">Habilitar ${esc(supplier.name || 'beneficiario')}</span><input type="checkbox" data-supplier-key="enabled" ${supplier.enabled ? 'checked' : ''}></label></div>${supplier.agreements.map((agreement,ai) => `<div class="agreement-row" data-agreement="${ai}"><div><label class="field-label" for="agreement-id-${index}-${ai}">Convenio</label><input id="agreement-id-${index}-${ai}" data-agreement-key="id" value="${esc(agreement.id)}" required></div><div><label class="field-label" for="agreement-max-${index}-${ai}">Límite</label><input id="agreement-max-${index}-${ai}" data-agreement-key="maxAmount" value="${esc(agreement.maxAmount)}" inputmode="decimal" required></div><div><label class="field-label" for="agreement-currency-${index}-${ai}">Moneda</label><input id="agreement-currency-${index}-${ai}" data-agreement-key="currency" value="${esc(agreement.currency)}" required></div><button type="button" class="icon-button" data-action="remove-agreement" data-supplier-index="${index}" data-agreement-index="${ai}" aria-label="Eliminar convenio ${esc(agreement.id)}">×</button></div>`).join('')}<div class="review-actions"><button class="button small ghost" data-action="add-agreement" data-supplier-index="${index}" type="button">+ Agregar convenio</button><button class="button small ghost" data-action="remove-supplier" data-supplier-index="${index}" type="button">Eliminar beneficiario</button></div></div>`; }

function audit() {
  const events = [...state.audit].reverse();
  return `<section class="section-heading"><div class="hero"><div class="eyebrow">NINGUNA DECISIÓN SIN RASTRO</div><h1>El historial explica<br>lo que pasó.</h1><p>Entradas, políticas y decisiones. Un registro local para inspeccionar y exportar.</p></div><div class="heading-actions"><button class="button secondary" data-action="export-csv">${svg('download')} CSV</button><button class="button primary" data-action="export-json">${svg('download')} Exportar JSON</button></div></section>${demoStrip()}<section class="panel"><div class="panel-head"><div><h2 class="panel-title">Bitácora de actividad <span class="count-pill">${events.length}</span></h2><p class="panel-subtitle">Revisión local ${state.revision} · política v${state.policy.version}</p></div><button class="button small ghost" data-action="reset">Restablecer demo</button></div>${events.length ? events.map(event => `<article class="audit-event"><div class="audit-date">${esc(dateLabel(event.at || event.timestamp, true))}</div><div class="audit-description"><strong>${esc(auditTitle(event))}</strong><p>${esc(event.actor || 'Motor de reglas local')}${event.invoiceId ? ` · ${esc(state.invoices.find(i=>i.id === event.invoiceId)?.number || event.invoiceId)}` : ''}</p><details><summary class="trace-link">Inspeccionar evento</summary><pre class="audit-details">${esc(JSON.stringify(event,null,2))}</pre></details></div></article>`).join('') : '<div class="empty-table"><h3>Tu historial empieza aquí.</h3><p>Las importaciones, decisiones y cambios de reglas quedarán registrados.</p></div>'}<div class="privacy-foot">El archivo exportado contiene datos ficticios de esta demostración. El almacenamiento local es editable por quien controla el navegador. No constituye un registro bancario ni un sistema de auditoría inalterable.</div></section>`;
}
function auditTitle(event) {
  const type = event.type || event.action || event.event;
  const names = {INVOICES_ADDED:`${event.count || ''} facturas importadas`, INVOICE_ADDED:'Factura importada', POLICY_UPDATED:'Política actualizada', DECISION_CREATED:'Decisión registrada', INVOICE_DECIDED:`Decisión: ${labels[event.status] || event.status || 'registrada'}`, HUMAN_REVIEW:`Revisión humana: ${labels[event.status] || event.status || 'registrada'}`, HUMAN_REJECTED:'Revisión humana rechazada', INVOICE_APPROVED:'Revisión humana aprobada', INVOICE_REJECTED:'Revisión humana rechazada', invoices_added:'Facturas importadas',policy_updated:'Política actualizada',decision:'Decisión registrada',approve:'Revisión humana aprobada',reject:'Revisión humana rechazada'};
  return names[type] || event.label || String(type || 'Actividad registrada').replaceAll('_',' ');
}

function tests() {
  return `<section class="section-heading"><div class="hero"><div class="eyebrow">LA CONFIANZA SE COMPRUEBA</div><h1>Resultados esperados.<br>Sin tocar tus datos.</h1><p>Un conjunto de facturas ficticias, expectativas explícitas y una política inicial independiente.</p></div><div class="heading-actions"><button class="button primary" data-action="run-tests">${svg('tests')} Ejecutar comprobaciones</button></div></section>${demoStrip()}<section class="panel"><div class="panel-head"><div><h2 class="panel-title">Banco de escenarios</h2><p class="panel-subtitle">Casos esperados definidos antes de ejecutar el motor.</p></div></div>${testResult ? `<div class="test-summary"><div class="test-score">${testResult.pass}/${testResult.total}</div><div><strong>${testResult.pass === testResult.total ? 'Todos los escenarios coinciden.' : 'Hay resultados que revisar.'}</strong><p>Estado aislado · ${esc(dateLabel(testResult.at,true))} · la bandeja no se modificó</p></div></div><div class="test-row header"><span>ESCENARIO</span><span>ESPERADO</span><span>OBTENIDO</span><span>ESTADO</span></div>${testResult.rows.map(row => `<div class="test-row"><div class="test-label"><strong>${esc(row.label)}</strong><span>${esc(row.id)}</span></div><div>${badge(row.expected,true)}</div><div>${badge(row.actual,true)}</div><span class="${row.pass ? 'test-pass' : 'test-fail'}">${row.pass ? '✓ OK' : '✕'}</span></div>`).join('')}<div class="test-info">${testResult.idempotent ? '✓ Volver a procesar conserva las reservas y el historial.' : '✕ La comprobación de idempotencia necesita revisión.'}<br>Estas comprobaciones verifican decisiones de un motor de reglas. No evalúan un modelo de IA ni sustituyen las pruebas automatizadas del repositorio.</div>` : `<div class="empty-table"><h3>Exige evidencia al resultado.</h3><p>Ejecuta ${DEMO_INVOICES.length} casos de referencia. La prueba crea y descarta su propio estado, sin modificar tu bandeja ni tu política.</p><button class="button primary" data-action="run-tests">Ejecutar comprobaciones ↗</button></div>`}<div class="privacy-foot">Incluye escenarios de pago simulado, revisión humana y freno. La tabla muestra el valor esperado y el valor calculado de cada factura, sin convertir el resultado del motor en su propia expectativa.</div></section>`;
}

function render() {
  $('#app').innerHTML = shell();
  bindEvents();
}
function bindEvents() {
  $('#app').querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => {
    tab = button.dataset.tab;
    policyDraft = null;
    render();
    $('#main-content').focus({preventScroll:true});
  }));
  $('#app').querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => action(button.dataset.action, button)));
  $('#app').querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {filter = button.dataset.filter; render();}));
  $('#app').querySelectorAll('tr[data-invoice]').forEach(row => row.addEventListener('click', () => {selectedId = row.dataset.invoice; render();}));
  $('#invoice-search')?.addEventListener('input', event => {
    const position = event.target.selectionStart;
    search = event.target.value;
    render();
    const input = $('#invoice-search');
    input.focus({preventScroll:true});
    if (input.type !== 'search') input.setSelectionRange(position,position);
  });
  $('#policy-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    readDraft();
    const saved = await mutate(current => updatePolicy(current, clone(policyDraft), context()), 'Política guardada. Las decisiones nuevas usarán esta versión.');
    if (saved) {policyDraft = null;render();}
  });
}
function readDraft() {
  const form = $('#policy-form');
  if (!form || !policyDraft) return;
  for (const key of ['autoLimit','paymentLimit','periodBudget','availableBalance','period','currency']) policyDraft[key] = $(`[name="${key}"]`,form).value.trim();
  policyDraft.beneficiaries = [...form.querySelectorAll('[data-supplier]')].map(element => ({
    id:$('[data-supplier-key="id"]',element).value.trim(),
    name:$('[data-supplier-key="name"]',element).value.trim(),
    enabled:$('[data-supplier-key="enabled"]',element).checked,
    agreements:[...element.querySelectorAll('[data-agreement]')].map(row => Object.fromEntries(['id','maxAmount','currency'].map(key => [key,$(`[data-agreement-key="${key}"]`,row).value.trim()])))
  }));
}

async function action(name, button) {
  if (name === 'open-import') {$('#import-error').textContent='';$('#import-dialog').showModal();return;}
  if (name === 'close-detail') {selectedId=null;render();return;}
  if (name === 'load-demo') {
    const existing = new Set(state.invoices.map(i=>i.id));
    const fresh = DEMO_INVOICES.filter(i=>!existing.has(i.id)).map(clone);
    if (!fresh.length) {toast('Los ejemplos ya están en tu bandeja. Procesa las facturas pendientes.');return;}
    selectedId = fresh[0]?.id ?? selectedId;
    await mutate(current => addInvoices(current, fresh, context()), `${fresh.length} facturas ficticias cargadas. Procesa la bandeja para ver las decisiones.`);
    return;
  }
  if (name === 'process') {await mutate(current=>processInvoices(current,context()), 'Bandeja procesada. Cada decisión conserva sus comprobaciones.');return;}
  if (name === 'approve' || name === 'reject') {
    const note = $('#review-note')?.value.trim() || '';
    if (note.length < 12 || note.split(/\s+/).length < 3) {toast('Escribe una nota de revisión de al menos tres palabras y 12 caracteres.',true);$('#review-note')?.focus();return;}
    const saved = await mutate(current => (name === 'approve' ? approveInvoice : rejectInvoice)(current,button.dataset.id,context(note)));
    if (saved) {
      const actual = getLatestDecision(state,button.dataset.id)?.status;
      toast(name === 'reject' ? 'Revisión rechazada. La decisión quedó en la bitácora.' : actual === 'PAY' ? 'Reglas vigentes aprobadas. Reserva simulada registrada.' : actual === 'BLOCK' ? 'La revalidación frenó la factura. Consulta las reglas que fallaron.' : 'La factura sigue en revisión. Corrige su contexto antes de aprobar.');
    }
    return;
  }
  if (name === 'add-supplier') {readDraft();policyDraft.beneficiaries.push({id:'',name:'',enabled:true,agreements:[{id:'',maxAmount:'500.00',currency:'USD'}]});render();return;}
  if (name === 'remove-supplier') {readDraft();policyDraft.beneficiaries.splice(Number(button.dataset.supplierIndex),1);render();return;}
  if (name === 'add-agreement') {readDraft();policyDraft.beneficiaries[Number(button.dataset.supplierIndex)].agreements.push({id:'',maxAmount:'500.00',currency:'USD'});render();return;}
  if (name === 'remove-agreement') {readDraft();policyDraft.beneficiaries[Number(button.dataset.supplierIndex)].agreements.splice(Number(button.dataset.agreementIndex),1);render();return;}
  if (name === 'export-json') {download(JSON.stringify({exportedAt:new Date().toISOString(),kind:'umbral-fictional-local-demo',notice:'Datos ficticios. No representa pagos reales.',...state},null,2),'umbral-bitacora.json','application/json');return;}
  if (name === 'export-csv') {exportCSV();return;}
  if (name === 'reset') {$('#confirm-dialog').showModal();return;}
  if (name === 'run-tests') {runTests();return;}
}

function download(content,filename,type) {
  const url = URL.createObjectURL(new Blob([content],{type:`${type};charset=utf-8`}));
  const link = document.createElement('a');
  link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Archivo exportado con los datos de esta demostración.');
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
function exportCSV() {
  const rows = [['decision_id','factura_id','factura','beneficiario','monto','moneda','decision','modo','version_politica','fecha','actor','razones','comprobaciones']];
  state.decisions.forEach(d => {const i=state.invoices.find(x=>x.id === d.invoiceId);rows.push([d.id,d.invoiceId,i?.number,i?.beneficiaryName,i?.amount,i?.currency,d.status,d.mode,d.policyVersion,d.at,d.actor,d.reasons.join(' | '),JSON.stringify(d.checks)]);});
  download('\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'),'umbral-decisiones.csv','text/csv');
}
function runTests() {
  try {
    let testState = createState(clone(DEFAULT_POLICY));
    testState = addInvoices(testState,clone(DEMO_INVOICES),{actor:'Banco de pruebas independiente',now:'2026-10-16T23:15:00.000Z'});
    testState = processInvoices(testState,{actor:'Banco de pruebas independiente',now:'2026-10-16T23:16:00.000Z'});
    const rows = DEMO_INVOICES.map(invoice=>{
      const expected = DEMO_EXPECTATIONS[invoice.id];
      const actual = getLatestDecision(testState,invoice.id)?.status || 'PENDING';
      return {id:invoice.id,label:scenarioLabels[invoice.id] || invoice.number,expected,actual,pass:expected === actual};
    });
    const again = processInvoices(clone(testState),{actor:'Banco de pruebas independiente',now:'2026-10-16T23:17:00.000Z'});
    const idempotent = JSON.stringify(testState.decisions) === JSON.stringify(again.decisions) && getMetrics(testState).reservedMinor === getMetrics(again).reservedMinor;
    testResult = {rows,pass:rows.filter(x=>x.pass).length,total:rows.length,at:new Date().toISOString(),idempotent};
    render();
    toast(`${testResult.pass}/${testResult.total} escenarios coinciden. ${idempotent ? 'Idempotencia verificada.' : 'Revisa la idempotencia.'}`,testResult.pass !== testResult.total || !idempotent);
  } catch(error) {toast(error.message || 'No se completó el banco de escenarios.',true);}
}

async function importInvoices(invoices) {
  if (!invoices.length) throw new Error('No se encontraron facturas en el archivo.');
  const id = invoices[0].id;
  const saved = await mutate(current=>addInvoices(current,invoices,context()), `${invoices.length} ${invoices.length === 1 ? 'factura importada' : 'facturas importadas'}. Revisa los datos antes de procesar.`);
  if (saved) {selectedId=id;tab='operations';filter='ALL';search='';$('#import-dialog').close();$('#invoice-text').value='';$('#invoice-file').value='';render();}
}
$('#paste-example').addEventListener('click',()=>{$('#invoice-text').value='Factura: FAC-021\nBeneficiario ID: norte\nBeneficiario: Norte Studio (ficticio)\nMonto: 120.00\nMoneda: USD\nVencimiento: 2026-10-20\nConvenio: DES-01\nDescripción: Ajuste de diseño de interfaz (ficticio)';$('#invoice-text').focus();});
$('#import-text-button').addEventListener('click',async()=>{
  $('#import-error').textContent='';
  try {
    const text=$('#invoice-text').value.trim();
    if (!text) throw new Error('Pega el texto de una factura ficticia.');
    await importInvoices([parseInvoiceText(text,{idPrefix:`import-${crypto.randomUUID()}`})]);
  } catch(error) {$('#import-error').textContent=error.message;}
});
$('#invoice-file').addEventListener('change',async event=>{
  $('#import-error').textContent='';
  const file=event.target.files[0];if(!file)return;
  try {
    if (file.size > 1_000_000) throw new Error('El archivo supera el límite de 1 MB.');
    const text=await file.text();
    await importInvoices(parseInvoiceFile(text,file.name,{idPrefix:`import-${crypto.randomUUID()}`}));
  } catch(error) {$('#import-error').textContent=error.message;event.target.value='';}
});
$('#cancel-reset').addEventListener('click',()=>$('#confirm-dialog').close());
$('#confirm-reset').addEventListener('click',async()=>{
  try {
    const reset = createState(DEFAULT_POLICY);
    reset.revision = state.revision + 1;
    if (storageError) {localStorage.removeItem(STORAGE_KEY);storageError='';state=createState(DEFAULT_POLICY);}
    else if (!await mutate(current=>({...reset,revision:current.revision+1}))) return;
    selectedId=null;policyDraft=null;testResult=null;filter='ALL';search='';$('#confirm-dialog').close();render();toast('Demostración restablecida. No se afectó ningún sistema externo.');
  } catch(error) {toast(error.message,true);}
});
window.addEventListener('storage', event=>{
  if (event.key !== STORAGE_KEY) return;
  try {state=readStoredState()??createState(DEFAULT_POLICY);policyDraft=null;storageError='';render();toast('Datos actualizados desde otra pestaña. Revisa el estado antes de continuar.');}
  catch(error){storageError=error.message;render();toast(error.message,true);}
});
render();
