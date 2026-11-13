"""Local-only, bounded-memory FFmpeg preparation. No provider/API dependency."""
from contextlib import contextmanager
from pathlib import Path
import logging
import os
import platform
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import wave

RATE = 16000
CHUNK_SECONDS = 600
OVERLAP_SECONDS = 8
LIMIT_SECONDS = 180 * 60
IO_BYTES = 64 * 1024
JOB_TTL_SECONDS = 6 * 60 * 60
ID_PATTERN = r"[0-9a-f]{32}"


class PreparationError(Exception):
    pass


def find_ffmpeg(app_dir):
    """Use the distributed native executable; never download or install at runtime."""
    override = os.environ.get('MEETINGMIND_FFMPEG')
    if override:
        candidate = shutil.which(override) or override
        if Path(candidate).is_file():
            return str(Path(candidate).resolve())
        raise PreparationError('MEETINGMIND_FFMPEG no apunta a un ejecutable disponible.')
    app_dir = Path(app_dir)
    if os.name == 'nt':
        machine = platform.machine().lower()
        bundled = app_dir / 'tools' / ('win32' if machine in ('x86', 'i386', 'i686') else '') / 'ffmpeg.exe'
        candidates = (bundled, app_dir / 'ffmpeg.exe')
    else:
        candidates = (app_dir / 'tools' / 'ffmpeg', app_dir / 'ffmpeg')
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())
    executable = shutil.which('ffmpeg')
    if executable:
        return executable
    raise PreparationError(
        'No se encontró el FFmpeg incluido con MeetingMind. Descarga y extrae '
        'el repositorio completo, incluida la carpeta tools. No hace falta instalarlo '
        'ni ejecutar la app como administrador. Si usas otro sistema, configura '
        'un FFmpeg compatible en PATH o MEETINGMIND_FFMPEG. No se envió audio a la IA.')


def prepare_audio(source, output, ffmpeg, *, progress=lambda *_: None,
                  cancelled=None, process_started=lambda _: None):
    """Validate through EOF, storing at most one new-content chunk plus its tail.

    The decoded sample count is authoritative, including for containers with
    missing or false duration metadata. Never use -t: an over-limit file fails.
    Only the successful caller may publish the returned manifest.
    """
    cancelled = cancelled or threading.Event()
    output = Path(output)
    command = [str(ffmpeg), '-v', 'error', '-nostdin', '-xerror', '-i', str(source),
               '-map', '0:a:0', '-ac', '1', '-ar', str(RATE),
               '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1']
    chunks, tail, total = [], b'', 0
    log_path = output / 'decode.log'
    with log_path.open('wb') as diagnostic:
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=diagnostic,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            process_started(proc)
            while True:
                # Read at most one sample beyond the limit to reject, not truncate.
                wanted = min(CHUNK_SECONDS * RATE, LIMIT_SECONDS * RATE - total + 1) * 2
                pcm = bytearray()
                while len(pcm) < wanted:
                    if cancelled.is_set():
                        raise PreparationError('Preparación local descartada.')
                    block = proc.stdout.read(min(IO_BYTES, wanted - len(pcm)))
                    if not block:
                        break
                    pcm.extend(block)
                if len(pcm) % 2:
                    raise PreparationError('FFmpeg produjo muestras PCM incompletas.')
                samples = len(pcm) // 2
                if total + samples > LIMIT_SECONDS * RATE:
                    raise PreparationError(
                        'El audio supera el límite de 180 minutos. Recorta el archivo '
                        'antes de procesarlo. No se envió audio a la IA.')
                if not samples:
                    break
                chunk_id = uuid.uuid4().hex
                with wave.open(str(output / (chunk_id + '.wav')), 'wb') as wav:
                    wav.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
                    wav.writeframesraw(tail)
                    wav.writeframesraw(pcm)
                chunks.append({
                    'id': chunk_id, 'samples': samples + len(tail) // 2,
                    'audioStartSec': (total - len(tail) // 2) / RATE,
                    'contentStartSec': total / RATE,
                    'durationSec': (samples + len(tail) // 2) / RATE,
                    'mimeType': 'audio/wav',
                })
                total += samples
                tail = bytes(pcm[-OVERLAP_SECONDS * RATE * 2:])
                progress(total / RATE, len(chunks))
            if proc.wait() != 0:
                raise PreparationError(
                    'FFmpeg no pudo decodificar todo el audio. Prueba convertirlo a WAV '
                    'o MP3; el diagnóstico está en server_errors.log. No se envió audio a la IA.')
            if cancelled.is_set():
                raise PreparationError('Preparación local descartada.')
            if not chunks:
                raise PreparationError('El archivo no contiene audio decodificable. No se envió audio a la IA.')
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.stdout.close()
            proc.wait()
    return {'durationSec': total / RATE, 'sampleRate': RATE, 'channels': 1,
            'sampleWidth': 2, 'chunkSeconds': CHUNK_SECONDS,
            'overlapSeconds': OVERLAP_SECONDS, 'chunks': chunks}


class AudioJob:
    def __init__(self):
        self.id = uuid.uuid4().hex
        self.directory = Path(tempfile.mkdtemp(prefix='meetingmind-audio-'))
        self.lock = threading.RLock()
        self.files_lock = threading.Lock()
        self.cancelled = threading.Event()
        self.state = 'awaiting-upload'
        self.touched = time.monotonic()
        self.received = 0
        self.total_bytes = 0
        self.prepared_seconds = 0
        self.prepared_chunks = 0
        self.manifest = None
        self.error = None
        self.process = None
        self.worker = None


class AudioJobs:
    def __init__(self, app_dir, *, ffmpeg_finder=find_ffmpeg):
        self.app_dir = Path(app_dir)
        self.ffmpeg_finder = ffmpeg_finder
        self.jobs = {}
        self.lock = threading.RLock()
        self.closed = threading.Event()
        threading.Thread(target=self._reap, daemon=True).start()

    def create(self):
        # Check availability before transferring a large file.
        executable = self.ffmpeg_finder(self.app_dir)
        with self.lock:
            if self.closed.is_set():
                raise PreparationError('El servidor local se está cerrando.')
            if len(self.jobs) >= 4:
                raise PreparationError('Hay demasiadas preparaciones locales. Espera a que terminen.')
            job = AudioJob()
            job.ffmpeg = executable
            self.jobs[job.id] = job
            return self.status(job.id)

    def _get(self, job_id):
        if not re.fullmatch(ID_PATTERN, job_id):
            raise KeyError(job_id)
        with self.lock:
            job = self.jobs[job_id]
        with job.lock:
            job.touched = time.monotonic()
        return job

    def status(self, job_id):
        job = self._get(job_id)
        with job.lock:
            result = {'id': job.id, 'state': job.state, 'receivedBytes': job.received,
                      'totalBytes': job.total_bytes, 'preparedSeconds': job.prepared_seconds,
                      'preparedChunks': job.prepared_chunks}
            if job.state == 'ready':
                result['manifest'] = job.manifest
            if job.state == 'failed':
                result['error'] = job.error
            return result

    def receive(self, job_id, stream, size):
        job = self._get(job_id)
        with job.lock:
            if job.state != 'awaiting-upload' or job.cancelled.is_set():
                raise PreparationError('Este trabajo ya recibió un archivo o fue descartado.')
            job.state, job.total_bytes = 'uploading', size
        try:
            with (job.directory / 'source.audio').open('wb') as destination:
                while job.received < size:
                    if job.cancelled.is_set():
                        raise PreparationError('Transferencia local descartada.')
                    block = stream.read(min(IO_BYTES, size - job.received))
                    if not block:
                        raise PreparationError('La transferencia local quedó incompleta. Vuelve a seleccionar el audio.')
                    destination.write(block)
                    with job.lock:
                        job.received += len(block)
                        job.touched = time.monotonic()
            with job.lock:
                if job.cancelled.is_set():
                    raise PreparationError('Transferencia local descartada.')
                job.state = 'preparing'
                job.worker = threading.Thread(target=self._prepare, args=(job,), daemon=True)
                job.worker.start()
        except Exception as exc:
            self._fail(job, exc)
            raise

    def _prepare(self, job):
        def progress(seconds, chunks):
            with job.lock:
                job.prepared_seconds, job.prepared_chunks = seconds, chunks
                job.touched = time.monotonic()

        def started(proc):
            with job.lock:
                job.process = proc
                if job.cancelled.is_set():
                    proc.kill()
        try:
            if job.cancelled.is_set():
                return
            manifest = prepare_audio(job.directory / 'source.audio', job.directory,
                                     job.ffmpeg, progress=progress,
                                     cancelled=job.cancelled, process_started=started)
            (job.directory / 'source.audio').unlink()
            with job.lock:
                if not job.cancelled.is_set():
                    job.manifest, job.state = manifest, 'ready'
                    job.touched = time.monotonic()
        except Exception as exc:
            self._fail(job, exc)
        finally:
            with job.lock:
                job.process = None
            if job.cancelled.is_set():
                self._clean(job)

    def _fail(self, job, exc):
        error = None
        if not job.cancelled.is_set():
            # Keep a bounded technical diagnosis after deleting the job's files.
            detail = ''
            try:
                with (job.directory / 'decode.log').open('rb') as diagnostic:
                    diagnostic.seek(0, 2)
                    diagnostic.seek(max(0, diagnostic.tell() - 8192))
                    detail = diagnostic.read().decode('utf-8', errors='replace')
            except OSError:
                pass
            logging.error('Local audio job %s failed (%s): %s\n%s', job.id,
                          type(exc).__name__, exc, detail)
            error = str(exc) if isinstance(exc, PreparationError) else (
                'Falló la preparación local. Revisa el espacio disponible, FFmpeg y '
                'server_errors.log. No se envió audio a la IA.')
        self._clean(job)
        if error is not None:
            with job.lock:
                job.state, job.manifest, job.error = 'failed', None, error

    @contextmanager
    def chunk(self, job_id, chunk_id):
        job = self._get(job_id)
        # Hold a lease so release cannot delete a WAV during a local download.
        with job.files_lock:
            with job.lock:
                if (job.cancelled.is_set() or job.state != 'ready' or
                        not any(c['id'] == chunk_id for c in job.manifest['chunks'])):
                    raise KeyError(chunk_id)
            with (job.directory / (chunk_id + '.wav')).open('rb') as source:
                yield source

    def _clean(self, job):
        with job.files_lock:
            try:
                shutil.rmtree(job.directory)
            except FileNotFoundError:
                pass
            except OSError:
                logging.exception('Could not remove local audio job %s', job.id)

    def release(self, job_id):
        with self.lock:
            job = self.jobs.pop(job_id, None)
        if job is None:
            return
        with job.lock:
            job.cancelled.set()
            if job.process is not None and job.process.poll() is None:
                job.process.kill()
            active = job.state in ('uploading', 'preparing')
        if not active:
            self._clean(job)

    def _reap(self):
        while not self.closed.wait(60):
            with self.lock:
                expired = [job.id for job in self.jobs.values()
                           if time.monotonic() - job.touched > JOB_TTL_SECONDS]
            for job_id in expired:
                self.release(job_id)

    def close(self):
        self.closed.set()
        with self.lock:
            jobs = list(self.jobs.values())
        for job in jobs:
            self.release(job.id)
        for job in jobs:
            if job.worker is not None:
                job.worker.join(timeout=5)
