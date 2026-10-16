# Controles y límites de la demostración

El objetivo es evitar autorizaciones automáticas fuera de las reglas. Una etiqueta de extracción, una instrucción dentro de una factura o una aprobación pendiente nunca sustituyen la política vigente.

Se comprueban, antes de reservar capacidad simulada: integridad de campos, importe decimal válido, moneda admitida, beneficiario permitido, acuerdo, tope por factura, duplicados y capacidad restante. Los casos dudosos se escalan. Los fallos duros se frenan.

La revisión humana necesita una nota, parte de un estado de revisión y ejecuta nuevamente los controles duros. Así, una factura que era aprobable deja de serlo si otra decisión consumió el presupuesto o se modificaron sus reglas. Repetir un procesamiento o aprobación no debe reservar dos veces el mismo pago.

El presupuesto del periodo y el saldo se calculan a partir de las decisiones conservadas, sin números en coma flotante para el dinero. Los cambios de política quedan registrados y no reescriben decisiones anteriores.

La importación limita tamaños y filas, conserva dudas de extracción y rechaza estructuras peligrosas. La interfaz presenta texto como texto. El navegador no envía facturas a terceros.

La persistencia local conserva una demo, no una bitácora inalterable ni una autorización bancaria. Un propietario del navegador conserva control sobre sus datos y su almacenamiento. No introducir información real o confidencial. La app no autentica a un revisor ni ejecuta transferencias.
