# Facturas sintéticas

Todos los nombres, identificadores y conceptos de estos archivos son ficticios. No contienen datos personales ni obligaciones reales. Ninguna acción mueve dinero.

- `invoice-message.txt`: una factura con etiquetas explícitas en español. Resultado esperado en estado inicial: PAY simulado por USD 125.50.
- `invoices.csv`: cotización CSV con una coma entre comillas. Orden esperado en estado inicial: PAY, REVIEW, BLOCK.
- `invoices.json`: montos almacenados como texto decimal. Orden esperado en estado inicial: PAY, REVIEW.

La carga integrada `DEMO_INVOICES` de `src/import.js` contiene 16 casos, en un orden intencional. `DEMO_EXPECTATIONS` define cada resultado antes de ejecutar el motor. Con DEFAULT_POLICY y estado vacío: 6 PAY, 6 BLOCK y 4 REVIEW. Reserva total prevista: 280000 centavos (USD 2,800.00). Saldo restante: USD 200.00. Presupuesto restante: USD 700.00.

| ID | Caso | Esperado |
|---|---|---|
| demo-001 | Beneficiario permitido y monto dentro del límite automático | PAY |
| demo-002 | Mismo beneficiario y número que una factura aprobada | BLOCK |
| demo-003 | Beneficiario desconocido | REVIEW |
| demo-004 | Identificador de acuerdo distinto del permitido | BLOCK |
| demo-005 | USD 850.00 dentro de acuerdo pero sobre límite automático | REVIEW |
| demo-006 | USD 2,100.00 sobre límite duro y acuerdo | BLOCK |
| demo-007 | EUR en una política USD | BLOCK |
| demo-008 | Dos montos posibles, sin escoger ninguno | REVIEW |
| demo-009 | Fecha inexistente | REVIEW |
| demo-010 a demo-014 | Facturas válidas que reservan en orden | PAY |
| demo-015 | USD 300.00 con saldo restante USD 200.00 | BLOCK |
| demo-016 | USD 800.00 con saldo USD 200.00 y presupuesto USD 700.00 | BLOCK |

Los archivos de muestra y la carga integrada deben probarse por separado, cada uno desde un estado vacío. Mezclarlos altera las reservas y cambia decisiones posteriores. Importar estos archivos no conserva identificadores internos: cada lote recibe IDs nuevos y el motor detecta duplicados comerciales por beneficiario y número.

La extracción es determinista y local, basada en etiquetas. No usa OCR ni interpreta PDF, imágenes, texto libre sin campos explícitos o símbolos de moneda como una autorización. Un dato ausente, ambiguo o inválido exige revisión humana. Los ejemplos JSON que incluyan números para `amount` fallan cerrados: el monto debe ser una cadena decimal.
