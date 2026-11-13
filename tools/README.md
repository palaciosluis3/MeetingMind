# FFmpeg incluido con MeetingMind

Estos ejecutables son dependencias de ejecución: **deben incluirse en Git y en
el ZIP de distribución**, junto con los archivos de esta carpeta. No usar Git
LFS para estos archivos si se quiere que un ZIP normal contenga los ejecutables.

| Archivo | Destino | Versión | SHA-256 |
|---|---|---|---|
| `ffmpeg.exe` | Windows x64 | 7.1, essentials de Gyan | `2ce797a0f88d7f067180338fb227f7b1928ea727bd9a4d7a1d022f7c52af71a3` |
| `win32/ffmpeg.exe` | Windows x86 | 4.2.2 | `67f43fd32c252d35948c5154486145c73c59e95c57e718c54fe650ff7f25fe48` |

Se copiaron sin modificar de los artefactos oficiales de **imageio-ffmpeg 0.6.0**:

- [Windows x64 en PyPI](https://pypi.org/project/imageio-ffmpeg/0.6.0/#files).
  Archivo `imageio_ffmpeg-0.6.0-py3-none-win_amd64.whl`, SHA-256
  `02fa47c83703c37df6bfe4896aab339013f62bf02c5ebf2dce6da56af04ffc0a`.
- Windows x86: `imageio_ffmpeg-0.6.0-py3-none-win32.whl`, SHA-256
  `196faa79366b4a82f95c0f4053191d2013f4714a715780f0ad2a68ff37483cc2`.

Los dos paquetes se verificaron por tamaño y SHA-256 antes de extraerlos. Cada
ejecutable tiene menos de 100 MiB; deben subirse mediante Git, no mediante el
formulario web de GitHub, cuyo límite es menor.

## Licencia, procedencia y fuentes

FFmpeg es software de sus respectivos autores; estas compilaciones habilitan
GPL y version3 y se distribuyen bajo **GNU GPL versión 3 o posterior**, sin
garantía. Se incluye el texto completo en `COPYING.GPLv3`. La licencia BSD del
paquete imageio-ffmpeg está en `LICENSE.imageio-ffmpeg.txt`; no sustituye la
licencia del ejecutable FFmpeg.

`VERSION-win64.txt` y `VERSION-win32.txt` conservan la versión exacta, compilador,
opciones de configuración y versiones de bibliotecas que informa cada binario.
Las fuentes y la información de sus distribuidores se encuentran en:

- [Fuentes FFmpeg 7.1](https://github.com/FFmpeg/FFmpeg/tree/n7.1) y
  [archivo de fuentes](https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz).
- [Fuentes FFmpeg 4.2.2](https://github.com/FFmpeg/FFmpeg/tree/n4.2.2) y
  [archivo de fuentes](https://ffmpeg.org/releases/ffmpeg-4.2.2.tar.xz).
- [Distribuidor de la compilación x64: Gyan](https://www.gyan.dev/ffmpeg/builds/).
- [Distribución original de binarios de imageio](https://github.com/imageio/imageio-binaries)
  e [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg).
- [Licencias y bibliotecas de FFmpeg](https://ffmpeg.org/legal.html).

Conservar estos avisos, configuración y referencias de fuentes junto a los
ejecutables al distribuirlos. La app invoca FFmpeg como un proceso independiente
para producir PCM; no importa ni instala el paquete Python imageio-ffmpeg.

## Funcionamiento

La app selecciona el ejecutable por arquitectura de Windows, sin descargar,
extraer ni instalar herramientas durante su uso. El audio se prepara en el
directorio temporal del sistema; no se escribe dentro de `tools/`.
Windows ARM64 requiere la emulación x64 del sistema. Para Linux/macOS se puede
proporcionar un ejecutable nativo en `tools/ffmpeg`, en PATH o mediante
`MEETINGMIND_FFMPEG`; estos binarios incluidos son exclusivamente de Windows.
