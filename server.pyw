
import http.server
import html
import json
import logging
import os
import sys
import shutil
import tempfile

import mimetypes

mimetypes.add_type('application/javascript', '.tsx')

# Under pythonw (no console) stdout/stderr are None; any library that writes to
# them blows up mid-request. Give them a sink so the server behaves the same
# headless as it does in a terminal.
for _name in ('stdout', 'stderr'):
    if getattr(sys, _name, None) is None:
        setattr(sys, _name, open(os.devnull, 'w', encoding='utf-8'))

PORT = 3000
DB_FILE = "database.json"
BACKUP_FILE = "database.json.bak"
CONFIG_FILE = "config.json"

# Per-user settings. This file is NEVER part of what gets distributed: it holds
# the API keys and the name of the person the app belongs to. Each user writes
# their own from the settings dialog; `config.example.json` is the copy that
# ships with the app.
DEFAULT_CONFIG = {
    "ownerName": "",
    "ownerAliases": [],
    "geminiApiKey": "",
    "openaiApiKey": "",
}


def write_json_atomic(path, data, backup_path=None):
    """Persist JSON without risking corruption on a crash or partial write.

    Writes to a temp file in the same directory, optionally keeps one rolling
    backup of the previous good copy, then atomically replaces the live file.
    """
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp_", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        if backup_path and os.path.exists(path):
            shutil.copy2(path, backup_path)
        os.replace(tmp_path, path)  # atomic on the same filesystem
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def save_db_atomic(data):
    write_json_atomic(DB_FILE, data, BACKUP_FILE)


def load_config():
    """Read config.json, filling in defaults for anything missing or invalid."""
    config = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            stored = json.load(f)
        if isinstance(stored, dict):
            for key in DEFAULT_CONFIG:
                if stored.get(key) is not None:
                    config[key] = stored[key]
    except FileNotFoundError:
        pass  # first run: the settings dialog will create it
    except (json.JSONDecodeError, OSError) as e:
        logging.error(f"config.json unreadable, falling back to defaults: {e}")

    if not isinstance(config.get("ownerAliases"), list):
        config["ownerAliases"] = []
    return config


def save_config(patch):
    """Merge a partial config over the stored one and persist it.

    Merging rather than replacing is what lets the settings dialog send a blank
    API key to mean "keep the current one". OpenAI shows a key exactly once, so
    an empty field must never be able to erase it.
    """
    config = load_config()
    for key in DEFAULT_CONFIG:
        if patch.get(key) is not None:
            config[key] = patch[key]
    write_json_atomic(CONFIG_FILE, config)
    return config

class PortableBackendHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        """Never touch sys.stderr.

        Launched without a console (pythonw / VBS launcher), sys.stderr is None,
        so the inherited log_message raised AttributeError on every request and
        the connection died with an empty reply. Send the line to the log file
        at DEBUG, i.e. off by default so it stays an error log.
        """
        logging.debug("%s - %s", self.address_string(), format % args)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'X-Requested-With, Content-type')
        # Always serve fresh assets: the app is transpiled in-browser from source,
        # so a cached .tsx would silently run stale code after edits.
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def do_GET(self):
        if self.path == "/config.js":
            # Served as a plain script so index.html can load it synchronously,
            # before the app starts. That keeps the configuration available at
            # module scope with no async boot ordering to get wrong.
            body = "window.MEETINGMIND_CONFIG = %s;\n" % json.dumps(
                load_config(), ensure_ascii=False)
            encoded = body.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-type', 'application/javascript; charset=utf-8')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return

        if self.path == "/api/db":
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            
            if os.path.exists(DB_FILE):
                with open(DB_FILE, 'r', encoding='utf-8') as f:
                    self.wfile.write(f.read().encode())
            else:
                self.wfile.write(json.dumps({}).encode())
            return
        return super().do_GET()

    def do_OPTIONS(self):
        self.send_response(200, "ok")
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/shutdown":
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"status": "shutting down"}).encode())
            
            # Kill server in background thread to let response send
            import threading
            import time
            def kill():
                time.sleep(1)
                os._exit(0)
            threading.Thread(target=kill).start()
            return

        if self.path == "/api/config":
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)

            try:
                patch = json.loads(post_data.decode('utf-8'))
                if not isinstance(patch, dict):
                    self.send_error(400, "Expected a JSON object")
                    return

                save_config(patch)

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok"}).encode())
            except Exception as e:
                logging.error(f"Failed to save config: {e}", exc_info=True)
                self.send_error(500, str(e))
            return

        if self.path == "/api/db":
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)

            try:
                data = json.loads(post_data.decode('utf-8'))
                # Guard against clobbering the DB with an unexpected shape.
                if not isinstance(data, dict):
                    self.send_error(400, "Expected a JSON object")
                    return

                save_db_atomic(data)
                generate_mobile_view(data)

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok"}).encode())
            except Exception as e:
                self.send_error(500, str(e))
            return

def generate_mobile_view(data):
    tasks = data.get('persistentTasks', [])
    last_sync = str(data.get('lastSync', '') or '').replace('T', ' ')[:16]

    config = load_config()
    owner_name = (config.get('ownerName') or '').strip()
    owner_first = owner_name.split()[0] if owner_name else ''
    owner_heading = f"Tareas de {owner_first}" if owner_first else "Mis tareas"

    # `is_owner` replaced `is_luis_palacios`. Read both so a database written by
    # an earlier version still lands in the right column.
    def belongs_to_owner(t):
        return bool(t.get('is_owner', t.get('is_luis_palacios', False)))

    owner_tasks = [t for t in tasks if not t.get('completed') and belongs_to_owner(t)]
    team_tasks = [t for t in tasks if not t.get('completed') and not belongs_to_owner(t)]
    completed_tasks = [t for t in tasks if t.get('completed')]

    # Priority first.
    owner_tasks.sort(key=lambda x: not x.get('is_priority', False))
    team_tasks.sort(key=lambda x: not x.get('is_priority', False))

    def esc(value, fallback=''):
        return html.escape(str(value or fallback))

    def render_task_card(t):
        return f'''
        <div class="glass p-5 rounded-2xl border-slate-800/50 {'neon-border' if t.get('is_priority') else ''}">
            <div class="flex justify-between items-start mb-3">
                <span class="text-[9px] font-black px-2 py-0.5 rounded {'bg-red-500 text-white' if t.get('is_priority') else 'bg-slate-800 text-slate-400'} uppercase tracking-tighter">
                    { 'Prioridad' if t.get('is_priority') else 'Tarea' }
                </span>
                <span class="text-[10px] text-slate-500 font-mono italic">#{esc(t.get('id'), 'N/A')}</span>
            </div>
            <p class="text-sm font-medium leading-relaxed text-slate-200 mb-4">{esc(t.get('description'))}</p>
            <div class="flex items-center gap-2">
                <div class="w-4 h-4 rounded-full bg-slate-800 flex items-center justify-center">
                    <svg class="w-2 h-2 text-slate-400" fill="currentColor" viewBox="0 0 20 20"><path d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"></path></svg>
                </div>
                <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{esc(t.get('assignee'), 'Sin asignar')}</span>
            </div>
        </div>
        '''

    html_content = f"""<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MeetingMind - Vista Móvil</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;900&family=JetBrains+Mono&display=swap" rel="stylesheet">
    <style>
        :root {{
            --cyber-neon: #00f2ff;
            --cyber-black: #020617;
        }}
        body {{
            background-color: var(--cyber-black);
            font-family: 'Outfit', sans-serif;
            color: white;
        }}
        .glass {{
            background: rgba(15, 23, 42, 0.6);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }}
        .neon-border {{
            border: 1px solid var(--cyber-neon);
            box-shadow: 0 0 15px rgba(0, 242, 255, 0.2);
        }}
        .font-mono {{ font-family: 'JetBrains Mono', monospace; }}
    </style>
</head>
<body class="p-4 pb-20">
    <header class="mb-8 pt-4">
        <div class="flex items-center gap-3 mb-2">
            <div class="w-2 h-2 bg-[var(--cyber-neon)] rounded-full animate-pulse shadow-[0_0_10px_#00f2ff]"></div>
            <h1 class="text-xl font-black tracking-widest uppercase">MeetingMind</h1>
        </div>
        <p class="text-[10px] text-slate-500 font-mono tracking-tighter">Actualizado: {last_sync}</p>
    </header>

    <section class="mb-10">
        <h2 class="text-[10px] font-black text-[var(--cyber-neon)] uppercase tracking-[0.3em] mb-4 opacity-70">{html.escape(owner_heading)}</h2>
        {"<p class='text-xs text-slate-600 italic px-2'>No hay tareas pendientes.</p>" if not owner_tasks else ""}
        <div class="space-y-4">
            {"".join([render_task_card(t) for t in owner_tasks])}
        </div>
    </section>

    <section class="mb-10">
        <h2 class="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em] mb-4 flex items-center gap-2">
             <span class="w-1.5 h-1.5 bg-slate-500 rounded-full"></span>
             Equipo
        </h2>
        {"<p class='text-xs text-slate-600 italic px-2'>No hay tareas pendientes para el equipo.</p>" if not team_tasks else ""}
        <div class="space-y-4">
            {"".join([render_task_card(t) for t in team_tasks])}
        </div>
    </section>

    <section class="mt-12 opacity-40">
        <h2 class="text-[10px] font-black text-emerald-500/50 uppercase tracking-[0.3em] mb-4 text-center">Completadas recientes</h2>
        <div class="space-y-2">
            {"".join([f'''
            <div class="glass p-3 rounded-xl border-slate-900/50 flex items-center gap-3">
                <div class="w-3 h-3 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <svg class="w-2 h-2 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>
                </div>
                <p class="text-[10px] text-slate-500 line-through truncate">{esc(t.get('description'))}</p>
            </div>
            ''' for t in completed_tasks[:5]])}
        </div>
    </section>

    <footer class="mt-12 text-center">
        <p class="text-[8px] text-slate-800 font-mono uppercase tracking-widest leading-loose">
            MeetingMind · Vista móvil<br>
            Solo lectura
        </p>
    </footer>
</body>
</html>"""

    with open("VISTA_MOVIL.html", 'w', encoding='utf-8') as f:
        f.write(html_content)


if __name__ == "__main__":
    # Ensure current dir is where the script is
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    # Simple logging: the only output channel when running as pythonw.
    logging.basicConfig(filename='server_errors.log', level=logging.INFO,
                        format='%(asctime)s %(levelname)s:%(message)s')

    try:
        server_address = ('127.0.0.1', PORT)
        httpd = http.server.HTTPServer(server_address, PortableBackendHandler)
    except OSError as e:
        # Port taken: another instance is already serving, so let it. Exit 3 so
        # the launcher can tell this apart from a real crash.
        logging.error(f"Port {PORT} unavailable, not starting a second instance: {e}")
        sys.exit(3)
    except Exception as e:
        logging.error(f"Server failed to start: {e}", exc_info=True)
        sys.exit(1)

    logging.info(f"MeetingMind backend active on port {PORT} - DB: {os.path.abspath(DB_FILE)}")
    print(f"===================================================")
    print(f"  MEETINGMIND BACKEND ACTIVE - PORT {PORT}")
    print(f"  DATABASE FILE: {os.path.abspath(DB_FILE)}")
    print(f"===================================================")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        logging.error(f"Server crashed: {e}", exc_info=True)
        sys.exit(1)
