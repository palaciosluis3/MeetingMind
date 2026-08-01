# MeetingMind

Transcribe una reunión grabada, redacta el acta y extrae las tareas, separando
las tuyas de las del resto del equipo.

Corre entero en tu computador: un servidor local en Python y una interfaz web.
No hay servicio en la nube donde registrarse ni base de datos compartida — cada
persona instala su copia, pone su propia API Key y sus datos no salen de su
equipo, salvo el audio que se envía al proveedor de IA para transcribirlo.

---

## Requisitos

| | |
|---|---|
| **Sistema** | Windows 10 u 11 |
| **Python** | Python 3 (probado con 3.13). Al instalarlo, marca la casilla **"Add Python to PATH"**. No requiere instalar ninguna librería. |
| **Navegador** | Microsoft Edge (viene con Windows). Si no está, se abre el navegador por defecto. |
| **API Key** | Una de Google Gemini, gratuita. Ver abajo. |

## Instalación

1. Descarga el repositorio (botón **Code → Download ZIP**) y descomprímelo donde
   quieras, por ejemplo en `Documentos\MeetingMind`.
2. Consigue tu API Key de Google Gemini en
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey): inicia sesión
   con tu cuenta de Google, pulsa *Crear clave de API* y copia el texto que
   aparece.
3. Doble clic en **`LaunchMeetingMind.vbs`**.

En el primer arranque la app te pedirá tu nombre y esa clave. No hace falta
editar ningún archivo a mano.

> Puedes crear un acceso directo a `LaunchMeetingMind.vbs` en el escritorio y
> cambiarle el icono por `favicon.ico`.

## Configuración

Todo lo tuyo se guarda en `config.json`, en la misma carpeta de la app. Se crea
solo la primera vez y puedes volver a él en cualquier momento con el icono del
engranaje, arriba a la derecha.

| Campo | Para qué sirve |
|---|---|
| **Tu nombre completo** | La app lo usa para separar tus tareas de las del equipo, y se lo pasa a la IA para que te reconozca en la conversación. |
| **Otros nombres con los que te llaman** | Apodos o el apellido a secas, separados por comas. Si en tus reuniones te dicen "Juancho" y tú te llamas Juan Pérez, ponlo aquí: mejora bastante el reconocimiento. |
| **API Key de Google Gemini** | Obligatoria. Genera el acta y las tareas, y transcribe el audio sin costo. |
| **API Key de OpenAI** | Opcional. Solo habilita dos modelos de transcripción de pago. Sin ella, todo funciona con Gemini. |

Al reabrir la configuración, los campos de clave aparecen vacíos a propósito:
**vacío significa "no la cambies"**. Así un guardado accidental no puede borrar
una clave que el proveedor ya no te va a volver a mostrar.

> ⚠️ **`config.json` contiene tus API Keys.** No lo subas a ningún repositorio ni
> lo compartas. El `.gitignore` de este proyecto ya lo excluye.

## Uso

1. **Cargar Audio** — acepta audio o video (`.mp3`, `.m4a`, `.wav`, `.mp4`…).
   Antes de subir nada, la app te muestra cuánto va a tardar y cuánto va a costar
   con cada modelo, calculado sobre la duración real de tu archivo.
2. Elige el modelo y confirma. Las grabaciones largas se parten en segmentos de
   10 minutos; el límite total es de 3 horas.
3. Al terminar quedan tres pestañas:
   - **Tareas** — tus tareas y las del equipo, en columnas separadas. Puedes
     marcarlas como completadas, añadir tareas a mano, importarlas y exportarlas
     en JSON.
   - **Minuta** — el acta redactada, las decisiones, los puntos clave y los
     participantes. Se descarga en Markdown.
   - **Transcripción** — la conversación con marca de tiempo y hablante. Busca
     dentro de ella, cópiala o descárgala en `.txt`.

Si la IA no logró ponerle nombre a alguien, verás "Hablante 1", "Hablante 2".
**Haz clic sobre el nombre para corregirlo**: el cambio se aplica a la
transcripción, a la minuta y a las tareas de esa persona.

### Modelos de transcripción

| Modelo | Costo | Velocidad | Separa hablantes |
|---|---|---|---|
| **Gemini 3.1 Flash Lite** | Gratis | ~45 s por cada 10 min de audio | Sí, por contexto |
| **OpenAI GPT Transcribe** | ~US$ 0,0045/min | El más rápido | **No** — texto corrido |
| **OpenAI GPT-4o Transcribe Diarize** | ~US$ 0,006/min | El más lento | Sí, el más preciso |

Los tiempos salen de mediciones reales sobre un mismo segmento de 10 minutos. El
acta y las tareas siempre las genera Gemini, sin importar quién transcriba.

Una reunión de una hora cuesta unos 36 centavos de dólar con el modelo de pago
más caro, 27 con el más barato, y nada con Gemini.

### Vista en el celular

Cada vez que se guardan cambios, la app regenera `VISTA_MOVIL.html`: un archivo
estático, de solo lectura, con tus tareas pendientes y las del equipo. Si tienes
la carpeta en OneDrive o similar, puedes abrirlo desde el teléfono para
consultar tus pendientes sin encender el computador.

## Dónde quedan tus datos

| Archivo | Contenido |
|---|---|
| `config.json` | Tu nombre y tus API Keys |
| `database.json` | Tareas y la última reunión procesada |
| `database.json.bak` | Copia de la versión anterior |
| `VISTA_MOVIL.html` | Vista para el celular, regenerada en cada guardado |

Los cuatro se quedan en tu computador y ninguno se sube al repositorio.

## Privacidad

Para transcribir, **el audio de tu reunión se envía a Google (y a OpenAI si
eliges uno de sus modelos)**. Vale la pena tenerlo presente antes de procesar
material sensible:

- Revisa si la política de datos de tu organización permite enviar grabaciones
  de reuniones a un servicio de IA externo.
- En el plan gratuito de la API de Gemini, Google puede usar el contenido para
  mejorar sus productos; en los planes de pago, no. Consulta los términos
  vigentes antes de decidir.
- Grabar y transcribir una reunión normalmente exige avisar a quienes participan.

## Problemas frecuentes

**"No se encontró Python en este equipo"**
No está instalado, o se instaló sin marcar *"Add Python to PATH"*. Instálalo
desde [python.org/downloads](https://www.python.org/downloads/) con esa casilla
marcada. El lanzador también reconoce el `py.exe` que instala python.org y las
carpetas de instalación habituales, así que basta con una instalación normal.

**"El servidor no respondió en 20 segundos"**
Casi siempre es que el puerto 3000 está ocupado por otro programa. Revisa
`server_errors.log`, en la carpeta de la app.

**La app se queda cargando o pierde la conexión**
Recargar la página (F5) **apaga el servidor local**: al cerrarse, la app le pide
al backend que se detenga. Si eso pasa, vuelve a abrir `LaunchMeetingMind.vbs`.

**Los modelos de OpenAI aparecen en gris**
No hay API Key de OpenAI configurada. Añádela en Configuración, o usa Gemini,
que es gratis y también separa hablantes.

**Una tarea quedó en la columna equivocada**
Añade en Configuración el apodo con el que te llaman en las reuniones. Las
tareas ya creadas puedes reasignarlas renombrando al hablante desde la pestaña
Transcripción.

## Para desarrolladores

No hay proceso de build: el `.tsx` se transpila en el navegador con Babel
standalone. Se edita el archivo y se recarga.

```
index.html                 Carga /config.js, Tailwind (CDN) y la app
MeetingMindPortable.tsx    Toda la interfaz y la integración con las IA
server.pyw                 Backend http.server: /api/db, /api/config, /config.js
LaunchMeetingMind.vbs      Lanzador silencioso (arranca el backend y abre Edge)
config.example.json        Plantilla de config.json
AGENTS.md                  Notas de arquitectura y decisiones de diseño
```

`AGENTS.md` documenta lo que no es evidente en el código: por qué la
transcripción se normaliza en un solo punto, por qué los segmentos duran 10
minutos, cómo se mantiene la continuidad de hablantes entre segmentos y qué
cosas no hay que "arreglar".
