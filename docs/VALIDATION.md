# Verificación de Umbral

16 de octubre de 2026. Node.js 24.19.0. Todos los casos usan datos ficticios y reservas simuladas. No se ejecutaron pagos.

## Pruebas automatizadas

- 57 pruebas de dominio, importación y persistencia aprobadas.
- 16 escenarios con resultados esperados independientes: 6 autorizaciones simuladas, 6 bloqueos y 4 revisiones.
- En el conjunto inicial, reserva simulada de USD 2.800, presupuesto restante de USD 700 y saldo restante de USD 200.
- Autonomía en ese conjunto: 75 %. Mide decisiones sin revisión humana, no precisión universal.
- Regresiones de duplicados con caracteres invisibles, importes contradictorios, reservas alteradas, datos ambiguos, campos ausentes, revisión con reglas cambiadas y conflictos de persistencia.
- Compilación de los archivos estáticos completada.

## Comprobación en navegador sobre la demo pública

La prueba se realizó en la publicación de GitHub Pages, en un navegador de escritorio. Se observaron estos resultados en la interfaz:

1. Se pegó e importó una factura TXT. La bandeja pasó a contener 17 facturas y permitió procesarlas.
2. Una revisión de la factura `AND-001`, por USD 850, quedó bloqueada al volver a comprobar el presupuesto disponible de USD 700 y el saldo disponible de USD 200. La revisión humana no omitió esos límites.
3. Se guardó la política versión 2 con presupuesto y saldo iniciales de USD 5.000. La factura importada `AND-HUM-01`, por USD 900, pasó de revisión humana a autorización simulada después de registrar una nota. Las reservas acumuladas quedaron en USD 3.700 y tanto el saldo como el presupuesto disponibles quedaron en USD 1.300.
4. El panel Pruebas mostró 16 de 16 escenarios coincidentes e idempotencia verificada. Ejecutarlo no alteró las 17 facturas de la bandeja.
5. La Bitácora mostró 22 eventos. La exportación JSON inició y completó la descarga del archivo en el navegador.
6. Tras recargar la página, se conservaron las 17 facturas, la política versión 2 y la revisión local 7.
7. Después de publicar la corrección y recargar, la factura `AND-002`, con fecha inexistente `2026-02-30`, mostró «Fecha no válida» y continuó en revisión.
8. El reproductor público cargó el MP4 completo de 96 segundos, sin errores de medios, y permitió iniciar la reproducción. El recorrido emplea ocho capturas reales y subtítulos en español, sin voz.

La vista previa interna falló al iniciar su proceso aislado con `bwrap`. Ese intento no cuenta como una prueba de navegador aprobada. La comprobación posterior en GitHub Pages sí permitió verificar los recorridos anteriores y resolvió el impedimento de acceso para la QA final.

## Alcance y comprobación pendiente

- No se comprobó la interfaz en un dispositivo móvil. El diseño responsive implementado no constituye evidencia de QA móvil.
- Durante la revisión pública se detectó que la fecha inexistente `2026-02-30` se mostraba como una fecha de marzo. El motor la mantuvo correctamente en revisión. La presentación se corrigió en `src/app.js` y se confirmó en la publicación actualizada: muestra «Fecha no válida» sin normalizar fechas inexistentes.
- La persistencia y la bitácora pertenecen al navegador. Esta comprobación no acredita un servicio bancario, transferencias reales ni un historial inalterable.
