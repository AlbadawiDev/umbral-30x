import test from 'node:test';
import assert from 'node:assert/strict';
import {createState, addInvoices, processInvoices} from '../src/domain.js';
import {DEMO_INVOICES} from '../src/import.js';
import {STORAGE_KEY, StorageConflict, InvalidStorage, validateState, readStoredState, commitState, mutateStoredState} from '../src/storage.js';
function memory() {const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
test('un historial válido conserva decisiones y reservas tras serialización',()=>{
  const storage=memory();const initial=createState();
  const state=processInvoices(addInvoices(initial,structuredClone(DEMO_INVOICES)));
  assert.equal(validateState(state),true);commitState(initial,state,storage);
  assert.deepEqual(readStoredState(storage),state);
});
test('dos pestañas con la misma revisión no pisan un cambio confirmado',()=>{
  const storage=memory();const first=createState();const second=structuredClone(first);
  const next=addInvoices(first,[structuredClone(DEMO_INVOICES[0])]);
  commitState(first,next,storage);
  assert.throws(()=>commitState(second,addInvoices(second,[structuredClone(DEMO_INVOICES[1])]),storage),StorageConflict);
  assert.equal(readStoredState(storage).invoices[0].id,DEMO_INVOICES[0].id);
});
test('un estado truncado, corrupto o con claves inseguras no se carga',()=>{
  const storage=memory();
  for(const raw of ['{','{}','{"schemaVersion":1,"revision":0,"__proto__":{}}']){
    storage.setItem(STORAGE_KEY,raw);assert.throws(()=>readStoredState(storage),InvalidStorage);
  }
});
test('un bloqueo vigente evita ejecutar el mutador de otra pestaña',async()=>{
  const storage=memory();storage.setItem(`${STORAGE_KEY}:lease`,JSON.stringify({owner:'other-tab',expires:Date.now()+10000}));
  let called=false;
  await assert.rejects(()=>mutateStoredState(createState(),current=>{called=true;return current;},storage),StorageConflict);
  assert.equal(called,false);
});
test('una cuota agotada no confirma un cambio que no se guardó',()=>{
  const storage=memory();storage.setItem=()=>{throw new Error('quota');};
  assert.throws(()=>commitState(createState(),addInvoices(createState(),[structuredClone(DEMO_INVOICES[0])]),storage),InvalidStorage);
  assert.equal(readStoredState(storage),null);
});
test('una política monetaria corrupta y un evento nulo se rechazan antes de renderizar',()=>{
  const value=createState();value.policy.autoLimit='NaN';assert.equal(validateState(value),false);
  const other=createState();other.audit.push(null);assert.equal(validateState(other),false);
});
