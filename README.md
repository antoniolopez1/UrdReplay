# 🌀 UrdReplay

https://github.com/antoniolopez1/UrdReplay

UrdReplay es una extensión de Firefox de código abierto que funciona como una alternativa inspirada en herramientas como **Jam Dev (Chrome)**, enfocada en mejorar el proceso de debugging, testing y análisis de aplicaciones web.

Su objetivo principal es **capturar, registrar y reproducir el contexto completo de una sesión de navegación**, permitiendo a desarrolladores y testers ver exactamente qué ocurrió durante la ejecución de una aplicación.

---

## 🧵 Origen del nombre: Urd

El nombre **Urd** proviene de la mitología nórdica.

Urd es una de las tres Nornas, hermanas del destino, y es la encargada de **tejer el pasado**.

En la mitología, Urd representa todo lo que ya ocurrió, registrando y entrelazando los eventos que forman la realidad.

Este concepto encaja directamente con el propósito del proyecto:

> UrdReplay busca “tejer” y reconstruir el pasado de una sesión de navegación, registrando cada evento como un hilo que luego puede ser inspeccionado, analizado y reproducido.

Cada request, log, error o interacción se convierte en un “hilo” que permite reconstruir lo sucedido con precisión.

---

## 🚀 Objetivo del proyecto

UrdReplay busca ser una herramienta open-source para Firefox que permita:

- Capturar sesiones completas de navegación
- Facilitar debugging reproducible
- Mejorar workflows de testing
- Registrar eventos clave de una aplicación web en tiempo real
- Servir como base para futuras integraciones con:
  - sistemas de casos de uso
  - gestión de tareas
  - reportes automáticos de errores

---

## 🎯 Funcionalidades actuales

UrdReplay captura y registra durante una sesión:

### 🌐 Eventos de red
- Requests HTTP/HTTPS
- Responses
- Status codes
- Información básica de timing

### 🧾 Consola del navegador
- console.log
- console.warn
- console.error
- stack traces

### ❌ Errores del sistema
- errores JavaScript en runtime
- errores de ejecución en páginas web
- fallos no capturados

### 🎥 Grabación de pantalla
- captura de la pantalla durante la sesión
- sincronización conceptual con eventos del navegador

---

## 🧩 Estado actual

Actualmente UrdReplay es una **extensión funcional de Firefox**, que puede instalarse de dos formas:

- como extensión temporal en modo desarrollo
- como instalación manual desde el gestor de complementos

---

## 🧰 Instalación

### 🔧 Requisitos

- Firefox (versión moderna recomendada)

---

### 🧪 Instalación en modo desarrollo (recomendado)

Este es el método más simple para probar la extensión:

1. Abrir Firefox
2. Ir a la siguiente ruta:
about:debugging#/runtime/this-firefox
3. Hacer clic en:
**“Cargar complemento temporal…”**
4. Seleccionar el archivo:
manifest.json
dentro del repositorio del proyecto

5. La extensión quedará activa hasta que Firefox se cierre.

---

### 📦 Instalación manual (opcional)

1. Comprimir el proyecto en un archivo `.zip`
2. (Opcional) Renombrarlo a `.xpi`
3. Ir a:

about:addons

4. Usar la opción:
**“Instalar complemento desde archivo”**

---

## 🧠 Arquitectura técnica (alto nivel)

UrdReplay está construido como una **WebExtension de Firefox**, utilizando APIs del navegador:

- Background scripts para lógica central
- Content scripts para interceptar información en pestañas
- Messaging system entre scripts
- APIs de tabs y webNavigation
- Captura de pantalla mediante `getDisplayMedia`
- Storage local para persistencia de eventos

---

## 🔮 Roadmap

- [ ] Panel de reproducción de sesiones (Replay UI)
- [ ] Exportación de sesiones (JSON / HAR / video)
- [ ] Integración con sistemas de tickets (Jira, etc.)
- [ ] Asociación de eventos con casos de uso
- [ ] Modo colaborativo para compartir sesiones
- [ ] Análisis automático de errores y logs

---

## 🤝 Contribución

Este proyecto está abierto a contribuciones.

Próximamente se agregará documentación sobre:
- estándares de código
- estructura del proyecto
- flujo de pull requests

---

## 📄 Licencia

Proyecto open-source (ver archivo LICENSE en el repositorio).

---

## 💡 Idea central

UrdReplay no solo registra datos.

Su objetivo es reconstruir la historia completa de una sesión de usuario como si fueran hilos entrelazados, permitiendo entender con precisión qué ocurrió, cuándo ocurrió y por qué ocurrió.

En esencia, transforma el debugging en una experiencia **reproducible, visual y trazable**.