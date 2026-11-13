"""Fetch a pinned native FFmpeg once, using only Python's standard library.

No pip, imports from the wheel, audio uploads, or machine-specific paths.
Artifacts and SHA-256 digests are from PyPI imageio-ffmpeg 0.6.0.
"""
import hashlib
import json
import logging
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import subprocess
import tempfile
import threading
import urllib.request
import zipfile

VERSION = '0.6.0'
ARTIFACTS = {
    'win_amd64': ('2c/c6/fa760e12a2483469e2bf5058c5faff664acf66cadb4df2ad6205b016a73d', '02fa47c83703c37df6bfe4896aab339013f62bf02c5ebf2dce6da56af04ffc0a', 31246824),
    'win32': ('a0/13/59da54728351883c3c1d9fca1710ab8eee82c7beba585df8f25ca925f08f', '196faa79366b4a82f95c0f4053191d2013f4714a715780f0ad2a68ff37483cc2', 19652251),
    'manylinux2014_x86_64': ('a0/2d/43c8522a2038e9d0e7dbdf3a61195ecc31ca576fb1527a528c877e87d973', 'c7e46fcec401dd990405049d2e2f475e2b397779df2519b544b8aab515195282', 29498237),
    'manylinux2014_aarch64': ('33/e7/1925bfbc563c39c1d2e82501d8372734a5c725e53ac3b31b4c2d081e895b', '1d47bebd83d2c5fc770720d211855f208af8a596c82d17730aa51e815cdee6dc', 25632706),
    'macosx_11_0_arm64': ('40/5c/f3d8a657d362cc93b81aab8feda487317da5b5d31c0e1fdfd5e986e55d17', 'b1ae3173414b5fc5f538a726c4e48ea97edc0d2cdc11f103afee655c463fa742', 21113891),
    'macosx_10_9_intel.macosx_10_9_x86_64': ('da/58/87ef68ac83f4c7690961bce288fd8e382bc5f1513860fc7f90a9c1c1c6bf', '9d2baaf867088508d4a3458e61eeb30e945c4ad8016025545f66c4b5aaef0a61', 24932969),
}
INSTALL_LOCK = threading.Lock()


def platform_tag():
    system, machine = platform.system(), platform.machine().lower()
    if system == 'Windows':
        # Windows ARM64 supports x64 emulation; execution is checked before use.
        if machine in ('amd64', 'x86_64', 'arm64', 'aarch64'):
            return 'win_amd64'
        if machine in ('x86', 'i386', 'i686'):
            return 'win32'
    if system == 'Linux':
        if machine in ('amd64', 'x86_64'):
            return 'manylinux2014_x86_64'
        if machine in ('aarch64', 'arm64'):
            return 'manylinux2014_aarch64'
    if system == 'Darwin':
        if machine in ('aarch64', 'arm64'):
            return 'macosx_11_0_arm64'
        if machine in ('amd64', 'x86_64'):
            return 'macosx_10_9_intel.macosx_10_9_x86_64'
    raise RuntimeError('Este sistema no tiene una descarga automática de FFmpeg compatible. Usa FFmpeg en PATH o MEETINGMIND_FFMPEG.')


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        while block := source.read(64 * 1024):
            digest.update(block)
    return digest.hexdigest()


def cached_binary(directory, digest):
    try:
        metadata = json.loads((directory / 'installation.json').read_text(encoding='utf-8'))
        binary = directory / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
        if (metadata['packageSha256'] == digest and binary.is_file() and
                metadata['binarySha256'] == file_digest(binary)):
            return str(binary.resolve())
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def ensure_ffmpeg(app_dir):
    tag = platform_tag()
    location, expected_hash, expected_size = ARTIFACTS[tag]
    root = Path(app_dir).resolve() / '.runtime'
    destination = root / ('ffmpeg-' + VERSION + '-' + tag)
    with INSTALL_LOCK:
        existing = cached_binary(destination, expected_hash)
        if existing:
            return existing
        try:
            root.mkdir(exist_ok=True)
            if root.resolve().parent != Path(app_dir).resolve():
                raise RuntimeError('La carpeta de herramientas debe estar dentro de la app.')
            with tempfile.TemporaryDirectory(prefix='ffmpeg-download-', dir=root) as temporary:
                work = Path(temporary)
                wheel = work / 'download.whl'
                filename = f'imageio_ffmpeg-{VERSION}-py3-none-{tag}.whl'
                url = f'https://files.pythonhosted.org/packages/{location}/{filename}'
                logging.info('Preparing native FFmpeg %s for %s', VERSION, tag)
                digest, count = hashlib.sha256(), 0
                request = urllib.request.Request(url, headers={'User-Agent': 'MeetingMind/1.0'})
                with urllib.request.urlopen(request, timeout=60) as response, wheel.open('wb') as output:
                    while block := response.read(64 * 1024):
                        count += len(block)
                        if count > expected_size:
                            raise ValueError('La descarga de FFmpeg supera el tamaño esperado.')
                        digest.update(block)
                        output.write(block)
                if count != expected_size or digest.hexdigest() != expected_hash:
                    raise ValueError('La descarga de FFmpeg no coincide con su SHA-256 y tamaño oficiales.')
                staged = work / 'ready'
                staged.mkdir()
                binary = staged / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
                with zipfile.ZipFile(wheel) as package:
                    candidates = [entry for entry in package.infolist()
                                  if PurePosixPath(entry.filename).parent == PurePosixPath('imageio_ffmpeg/binaries')
                                  and PurePosixPath(entry.filename).name.startswith('ffmpeg-')
                                  and not entry.is_dir()]
                    if len(candidates) != 1 or candidates[0].file_size > 200 * 1024 * 1024:
                        raise ValueError('El paquete no contiene un único ejecutable FFmpeg válido.')
                    # No extractall: archive entries cannot choose filesystem paths.
                    with package.open(candidates[0]) as source, binary.open('wb') as output:
                        shutil.copyfileobj(source, output, length=64 * 1024)
                    licenses = [entry for entry in package.infolist()
                                if PurePosixPath(entry.filename).name in ('LICENSE', 'LICENSE.txt')
                                and entry.file_size < 1024 * 1024]
                    for index, entry in enumerate(licenses):
                        (staged / f'PACKAGE-LICENSE-{index}.txt').write_bytes(package.read(entry))
                binary.chmod(binary.stat().st_mode | 0o111)
                result = subprocess.run([str(binary), '-version'], stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, timeout=15,
                                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                if result.returncode or not result.stdout.startswith(b'ffmpeg version '):
                    raise RuntimeError('El ejecutable FFmpeg no funciona en este equipo.')
                metadata = {'package': filename, 'url': url, 'packageSha256': expected_hash,
                            'binarySha256': file_digest(binary)}
                (staged / 'installation.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
                (staged / 'ORIGIN.txt').write_text(
                    'Native FFmpeg supplied by imageio-ffmpeg.\n'
                    'https://pypi.org/project/imageio-ffmpeg/0.6.0/\n'
                    'https://github.com/imageio/imageio-ffmpeg\n'
                    'FFmpeg licensing/source information: https://ffmpeg.org/legal.html\n', encoding='utf-8')
                # Only replace this version's controlled cache directory. A failed
                # download never publishes an executable and is safe to retry.
                if destination.exists():
                    existing = cached_binary(destination, expected_hash)
                    if existing:
                        return existing
                    if destination.resolve().parent != root.resolve():
                        raise RuntimeError('Ruta de caché de FFmpeg fuera de la app.')
                    shutil.rmtree(destination)
                staged.rename(destination)
            return str((destination / binary.name).resolve())
        except Exception:
            logging.exception('Automatic FFmpeg preparation failed (%s)', tag)
            raise RuntimeError(
                'No se pudo preparar FFmpeg automáticamente. La primera vez se necesita '
                'conexión a files.pythonhosted.org y permiso de escritura en la carpeta '
                'de la app. Revisa la conexión, el espacio libre y server_errors.log e '
                'inténtalo de nuevo. No se envió audio a la IA.') from None
