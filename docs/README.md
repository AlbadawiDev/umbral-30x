# Umbral

Decisiones de pago verificables. Proyecto de Albadawi Lab para el reto Blinka del Hackathon 30X, iniciado el 16 de octubre de 2026 después del kickoff.

Umbral recibe facturas ficticias como texto de correo o chat, CSV o JSON. Un agente determinista contrasta cada factura con reglas configurables y propone pagar, frenar o pedir revisión humana. Cada decisión conserva los hechos, las comprobaciones y la versión de las reglas. No conecta con bancos ni mueve dinero.

## Ejecutar

Requiere Node.js 24 para ejecutar las pruebas y preparar los archivos estáticos. La aplicación publicada funciona en un navegador moderno sin instalar paquetes ni obtener claves API.

```sh
npm test
npm run build
python3 -m http.server 8080 --directory dist
```

Abre `http://localhost:8080`. Los módulos ES requieren un servidor HTTP, no abrir el HTML con `file://`.

## Recorrido

1. Carga los ejemplos ficticios.
2. Procesa el lote y revisa los resultados y la capacidad restante.
3. Abre una decisión para leer sus comprobaciones.
4. Revisa una factura escalada. La aprobación requiere una explicación y vuelve a comprobar los límites vigentes.
5. Cambia las reglas, revisa la bitácora y exporta la evidencia.

## Arquitectura

- `src/domain.js`: política, validación exacta de importes, reservas simuladas, decisiones y revisión humana.
- `src/import.js`: lectura conservadora de texto, CSV y JSON, con problemas de extracción explícitos.
- `src/storage.js`: persistencia de la demostración en el navegador y control de revisiones.
- `src/app.js`: interfaz y coordinación de flujos.
- `tests/`: casos normales, trampas, precisión monetaria, importación y cambios de reglas.
- `fixtures/`: empresa, proveedores y facturas inventados, con resultados esperados.

## Alcance

La demostración trabaja en USD y conserva los importes en centavos enteros. No convierte monedas. Los datos permanecen en el almacenamiento local de ese navegador. No envía correos, no carga documentos en servicios externos y no toma decisiones de cumplimiento o fraude.

No interpreta imágenes ni PDF escaneados. Los campos ausentes o ambiguos quedan para revisión. Una aprobación humana no corrige automáticamente datos ni salta restricciones duras.

Es un prototipo de un usuario para datos ficticios. No constituye un sistema financiero de producción ni autentica a un aprobador real. Las decisiones y los saldos son simulaciones. Para producción harían falta control de acceso en servidor, almacenamiento transaccional, aprobación autenticada e integración autorizada con los sistemas de la empresa.

## Autor y reto

Presentado por Daniel Samir Al Badawi Aazar, estudiante de Informática, UDO Núcleo Sucre, Cumaná, Venezuela.

- [Portafolio](https://albadawidev.github.io/)
- [GitHub](https://github.com/AlbadawiDev)
- [Reto Blinka](https://hackradar.30x.com/recursos/blinka)

Los nombres, acuerdos, importes y mensajes de ejemplo son ficticios. No representan clientes ni relaciones comerciales reales.
