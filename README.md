# MeetingMind

Transcribe una reunión grabada, redacta el acta y extrae las tareas, separando
las tuyas de las del resto del equipo.

Corre entero en tu computador: un servidor local en Python y una interfaz web.
No hay servicio en la nube donde registrarse ni base de datos compartida — cada
persona instala su copia, pone su propia API Key y sus datos no salen de su
equipo, salvo el audio que se envía al proveedor de IA para transcribirlo.

---

## Requisitos

Las pruebas locales de regresión y su comando de ejecución están documentados en
[tests/README.md](tests/README.md). Usan datos sintéticos y no acceden a tu configuración,
base de datos ni APIs de IA.

| | |
|---|---|
| **Sistema** | Windows 10 u 11 |
| **Python** | Python 3 (probado con 3.13). Al instalarlo, marca la casilla **"Add Python to PATH"**. No requiere instalar ninguna librería. |
| **FFmpeg** | La app lo descarga y verifica automáticamente cuando preparas el primer audio. Solo esa primera preparación necesita acceso a `files.pythonhosted.org`; después reutiliza su copia local. No requiere pip ni instalación manual. |
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
2. Elige el modelo y el tipo de sesión. El archivo se transfiere al servidor
   **local de tu propio equipo**, donde FFmpeg lo prepara en segmentos de 10
   minutos. El límite total es de 3 horas y se comprueba antes de enviar audio
   al proveedor de IA. Después comienza la transcripción con el modelo elegido.
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
transcripción de esa reunión y a sus etiquetas de participante y tareas vinculadas.
El contenido de la minuta y las tareas queda **pendiente de revisión**.

En Transcripción también puedes **reasignar una intervención**, **fusionar
hablantes duplicados** de forma explícita y **deshacer** hasta 20 correcciones
durante la sesión. Los tiempos y la procedencia se conservan. Reasignar o fusionar
no cambia automáticamente los responsables de las tareas.

**Corregir hablantes por segmento** permite elegir un segmento o un rango con
los controles **Desde** y **Hasta**. Puedes reemplazar las intervenciones de cada
hablante por otro de la reunión, o seleccionar dos voces y pulsar **Preparar
intercambio A↔B** para revertir una inversión. Revisa la vista previa y pulsa
**Aplicar corrección**: todos los reemplazos ocurren simultáneamente, incluso
en intervenciones ocultas por una búsqueda. **Deshacer** revierte el grupo completo.
Cada intervención muestra su segmento de origen; **Ir al inicio** abre ese punto.
Las transcripciones antiguas sin procedencia conservan la edición individual y
la fusión, pero no pueden agruparse en segmentos que no fueron guardados.

Gemini puede reconocer a los mismos participantes y aun así invertir sus voces.
Si una referencia acústica contradice la evidencia fuerte del solapamiento, la
app deja esas identidades separadas con un aviso para revisión. También evita
unir dos voces locales cuando distintos mecanismos apuntan a una sola identidad.
Esto detecta contradicciones disponibles; no garantiza que todas las atribuciones
sean correctas. La corrección por segmento permite resolver manualmente las
inversiones restantes sin volver a transcribir el audio.

**Regenerar análisis con Gemini** envía solo la transcripción corregida y puede
generar costo. Primero muestra una propuesta: puedes aplicar la minuta y elegir
qué tareas nuevas añadir. Las tareas acumuladas y sus correcciones se conservan;
ninguna propuesta de tarea se selecciona automáticamente. Revisa posibles
reformulaciones de tareas existentes antes de añadirlas.

Durante el procesamiento puedes desplegar la **transcripción provisional** de los
fragmentos terminados. Esa vista no se guarda automáticamente; el resultado final
o parcial se guarda al terminar. Aún no hay cancelación activa ni recuperación
del procesamiento después de cerrar o recargar la ventana.

Los avisos tienen una **X** para ocultarlos. **Mostrar avisos ocultos** permite
recuperarlos; cerrar un aviso no elimina su registro ni marca el análisis como
revisado. En la fusión, **Actual** es el hablante que quieres reemplazar y
**Reemplazar por:** es el hablante que conservarás.

### Modelos de transcripción

| Modelo | Costo | Velocidad | Separa hablantes |
|---|---|---|---|
| **Gemini 3.5 Flash-Lite** | Gratis | ~45 s por cada 10 min de audio | Sí, por contexto |
| **OpenAI GPT Transcribe** | ~US$ 0,0045/min | El más rápido | **No** — texto corrido |
| **OpenAI GPT-4o Transcribe Diarize** | ~US$ 0,006/min | El más lento | Sí, el más preciso |

Los tiempos salen de mediciones reales sobre un mismo segmento de 10 minutos. El
acta y las tareas siempre las genera Gemini, sin importar quién transcriba.

Una reunión de una hora cuesta unos 36 centavos de dólar con el modelo de pago
más caro, 27 con el más barato, y nada con Gemini.

### Preparación local y audios largos

El navegador conserva el archivo comprimido y carga un solo WAV preparado a la
vez; ya no necesita decodificar toda la grabación con Web Audio. FFmpeg procesa
el audio progresivamente como PCM16 mono a 16 kHz. Cada segmento contiene hasta
600 segundos nuevos, con 8 segundos anteriores de solapamiento desde el segundo
(hasta 608 segundos por WAV). El último conserva solo las muestras restantes.
Estéreo no significa que cada canal corresponda a una persona.

Verás **transferencia al servidor local**, **preparación con FFmpeg** y después
la subida/transcripción con el proveedor. Solo la transferencia medible muestra
porcentaje; durante la preparación se informa cuántos segmentos se han creado,
sin tratarlos como completos hasta validar el archivo entero. Ese tiempo local
se registra en Preparación; las estimaciones de los modelos siguen sin incluirlo.

FFmpeg se busca en este orden:

1. Ruta o comando indicado por la variable de entorno `MEETINGMIND_FFMPEG`.
2. `tools/ffmpeg.exe` junto a la app, o `ffmpeg.exe` en la carpeta de la app.
3. El comando `ffmpeg` en `PATH`.
4. Su caché verificada en `.runtime/`. Si no existe o está dañada, descarga un
   artefacto fijo de `imageio-ffmpeg 0.6.0` desde PyPI, comprueba su tamaño y SHA-256,
   extrae únicamente FFmpeg y sus avisos, y comprueba que pueda ejecutarse.

Una copia descargada de GitHub no necesita que el usuario instale FFmpeg ni
paquetes Python: `ffmpeg_runtime.py` hace esta preparación con la biblioteca
estándar, solo al procesar el primer audio, y reutiliza el ejecutable después.
La interfaz muestra actividad durante esa primera descarga. Los binarios y la
caché están excluidos de Git; el instalador Python sí debe incluirse en el repo.
No hay dependencia de `../.audio-tools/` ni rutas de este computador.

Hay artefactos para Windows x86/x64, Linux glibc x64/ARM64 y macOS Intel/ARM64.
Windows ARM64 usa la emulación x64 del sistema; el ejecutable se valida antes de
usarlo. La descarga y ejecución real se comprobaron en Windows x64; los demás
sistemas solo tienen comprobaciones de selección de artefacto, no pruebas en esos
equipos. El lanzador VBS sigue siendo de Windows; en otros sistemas se inicia
`python server.pyw` y se abre `http://127.0.0.1:3000` en el navegador.

La primera preparación necesita internet, espacio libre y permiso de escritura
en la carpeta de la app. Si la red bloquea PyPI, el proceso informa el error y
permite reintentar; también siguen disponibles FFmpeg en PATH y la ruta opcional
`MEETINGMIND_FFMPEG`. No se envía audio a PyPI ni se inicia la transcripción si
falla la preparación de la herramienta. Tras actualizar la app, cierra la ventana
y vuelve a iniciar `LaunchMeetingMind.vbs` para cargar el servidor nuevo.

Los trabajos guardan el original y sus WAV en carpetas aisladas del directorio
temporal del sistema (`meetingmind-audio-*`). El original temporal se elimina
al terminar de preparar; los WAV, al terminar de usarlos, fallar la preparación
o cerrar normalmente el servidor. Los trabajos abandonados caducan después de
seis horas sin actividad. Se necesita espacio temporal para la copia del archivo
y los WAV (aproximadamente 346 MB de PCM para tres horas, más solapamientos).
Un cierre forzado del proceso puede dejar temporales; no hay recuperación tras
recarga ni cancelación de solicitudes a proveedores.

Si no se puede obtener FFmpeg, falla la decodificación o la duración real supera 180 minutos,
el proceso se detiene antes de enviar audio a la IA. No se recorta al límite ni
se utiliza el archivo original como respaldo. `server_errors.log` conserva el
diagnóstico técnico local. El servidor sigue atendiendo peticiones mientras
transfiere y prepara audio.

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
audio_preparation.py       FFmpeg progresivo, trabajos temporales y manifiestos
ffmpeg_runtime.py          Descarga verificada y caché del ejecutable FFmpeg
.runtime/                 Caché local generada, excluida de Git
LaunchMeetingMind.vbs      Lanzador silencioso (arranca el backend y abre Edge)
config.example.json        Plantilla de config.json
AGENTS.md                  Notas de arquitectura y decisiones de diseño
```

`AGENTS.md` documenta lo que no es evidente en el código: por qué la
transcripción se normaliza en un solo punto, por qué los segmentos duran 10
minutos, cómo se mantiene la continuidad de hablantes entre segmentos y qué
cosas no hay que "arreglar".

La preparación añade `POST /api/audio/jobs`, `POST /api/audio/jobs/<id>/source`,
`GET /api/audio/jobs/<id>`, `GET /api/audio/jobs/<id>/chunks/<id>` y
`POST /api/audio/jobs/<id>/release`. El cliente usa identificadores aleatorios;
no puede elegir rutas del sistema. Estos endpoints solo admiten el origen local.
El servidor usa hilos y serializa las escrituras de configuración/base de datos
y la generación de la vista móvil para evitar carreras.
