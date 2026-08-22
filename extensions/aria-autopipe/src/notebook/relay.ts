/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The Python "relay" that runs INSIDE the run environment (WSL/vfkit/SSH), driven
 * over a single persistent SSH exec channel by the NotebookController.
 *
 * It uses jupyter_client to launch and manage an IPython kernel locally in the VM
 * (so ZMQ never crosses the SSH boundary - no port forwarding needed), and speaks
 * line-delimited JSON both ways:
 *
 *   stdin  (controller -> relay):
 *     { "type": "execute",   "id": "<cellId>", "code": "..." }
 *     { "type": "interrupt" }
 *     { "type": "restart" }
 *     { "type": "shutdown" }
 *
 *   stdout (relay -> controller), one JSON object per line:
 *     { "type": "ready" }
 *     { "type": "input",   "id", "count" }
 *     { "type": "stream",  "id", "name": "stdout"|"stderr", "text" }
 *     { "type": "display", "id", "data": { "<mime>": <value> }, "result": bool }
 *     { "type": "error",   "id", "ename", "evalue", "traceback": [..] }
 *     { "type": "status",  "id", "state": "busy"|"idle" }
 *     { "type": "reply",   "id", "status": "ok"|"error", "count" }
 *     { "type": "fatal",   "error" }
 *
 * Kept dependency-light (stdlib + jupyter_client + ipykernel) so it installs fast
 * into a per-project micromamba (conda) env.
 */
export const RELAY_PY = String.raw`
import sys, os, json, signal, threading, queue, subprocess, tempfile, time

def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
    except Exception:
        pass

# Terminate any PARTIAL line the setup left on stdout before this relay took over.
# Some tools (e.g. micromamba) print a status like {"success": true} WITHOUT a
# trailing newline; without this it would concatenate with our first message
# ({"success": true}{"type": "ready"}) and the controller could not parse it, so the
# cell hung right after 'ready'. A leading newline puts our messages on their own line.
try:
    sys.stdout.write("\n")
    sys.stdout.flush()
except Exception:
    pass

try:
    from jupyter_client import KernelManager
except Exception as e:
    emit({"type": "fatal", "error": "jupyter_client import failed: %s" % e})
    sys.exit(1)

km = KernelManager(kernel_name="python3")
_kerr_path = None
_ready_evt = threading.Event()

def _startup_watchdog():
    # Fires if the kernel is not ready within 100s NO MATTER where startup hangs -
    # km.start_kernel(), kc.start_channels() and kc.wait_for_ready() can ALL block
    # (e.g. on a remote server whose NFS home stalls the connection file). Reports
    # the kernel's captured stderr so the hang is diagnosable, then exits.
    if _ready_evt.wait(100):
        return
    tail = ""
    try:
        if _kerr_path:
            with open(_kerr_path) as f:
                tail = f.read()[-2000:]
    except Exception:
        pass
    a = None
    try:
        a = km.is_alive()
    except Exception:
        pass
    emit({"type": "fatal", "error": "kernel start hung (>100s, alive=%s):\n%s" % (a, tail.strip())})
    os._exit(1)

threading.Thread(target=_startup_watchdog, daemon=True).start()

try:
    # Isolate the kernel's own stdio from OUR stdout (which carries the JSON
    # protocol). Its stdout goes to DEVNULL so kernel prints can't corrupt our
    # "ready"/output lines; its STDERR is captured to a file so that if the kernel
    # crashes on startup (why "launching kernel" would hang) we can report the reason.
    # Cell stdout/stderr still comes back over ZMQ (iopub), not these pipes.
    try:
        _kerr = tempfile.NamedTemporaryFile(mode="w+", suffix=".qoka-kernel-err", delete=False)
        _kerr_path = _kerr.name
        # Give the kernel its OWN empty stdin (DEVNULL), NOT this relay's stdin. Over a
        # remote SSH exec channel the kernel subprocess would otherwise inherit the SSH
        # channel's stdin and swallow the controller's execute commands, so the relay's
        # readline() never sees them - the cell hangs right after 'ready' (works locally
        # because the timing differs). DEVNULL leaves the relay the SOLE stdin reader.
        km.start_kernel(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=_kerr)
    except TypeError:
        km.start_kernel()
    kc = km.client()
    kc.start_channels()
    # Poll for readiness with our OWN bounded deadline instead of one long
    # wait_for_ready(), which can hang indefinitely if the kernel died or its
    # channels never connected. Check is_alive() each round so a crashed kernel is
    # reported FAST (with its stderr), rather than waiting out a long timeout.
    _deadline = time.time() + 90
    _ready = False
    while time.time() < _deadline:
        if not km.is_alive():
            raise RuntimeError("the kernel process exited before it became ready")
        try:
            kc.wait_for_ready(timeout=3)
            _ready = True
            break
        except Exception:
            pass
    if not _ready:
        raise RuntimeError("the kernel did not become ready within 90s")
except Exception as e:
    tail = ""
    try:
        if _kerr_path:
            with open(_kerr_path) as f:
                tail = f.read()[-2000:]
    except Exception:
        pass
    alive = None
    try:
        alive = km.is_alive()
    except Exception:
        pass
    emit({"type": "fatal", "error": "kernel start failed (alive=%s): %s\n%s" % (alive, e, tail.strip())})
    sys.exit(1)

# Kill the kernel if this relay is signalled - e.g. the SSH channel dropped on a
# restart/close (no PTY, so the server may SIGHUP us) - so no orphaned kernel
# lingers on the remote and a fresh restart starts clean.
def _shutdown(*_a):
    try:
        kc.stop_channels()
    except Exception:
        pass
    try:
        km.shutdown_kernel(now=True)
    except Exception:
        pass
    os._exit(0)

for _signame in ("SIGTERM", "SIGHUP"):
    try:
        signal.signal(getattr(signal, _signame), _shutdown)
    except Exception:
        pass

_ready_evt.set()  # kernel is up - stand the startup watchdog down
emit({"type": "ready"})

# The single in-flight cell id. Cells run STRICTLY sequentially (the controller
# waits for each cell's reply before sending the next), so one holder is enough -
# and it avoids a race where an iopub output arrives before a msg-id -> cell-id map
# entry is stored, which would drop the output (that broke output over SSH).
current = {"id": None}
lock = threading.Lock()

def cur():
    with lock:
        return current["id"]

def iopub_loop():
    while True:
        try:
            msg = kc.get_iopub_msg(timeout=1)
        except queue.Empty:
            continue
        except Exception:
            break
        cid = cur()
        t = msg["header"]["msg_type"]
        c = msg.get("content") or {}
        if t == "stream":
            emit({"type": "stream", "id": cid, "name": c.get("name"), "text": c.get("text")})
        elif t in ("execute_result", "display_data"):
            emit({"type": "display", "id": cid, "data": c.get("data") or {}, "result": t == "execute_result"})
        elif t == "error":
            emit({"type": "error", "id": cid, "ename": c.get("ename"), "evalue": c.get("evalue"), "traceback": c.get("traceback") or []})
        elif t == "execute_input":
            emit({"type": "input", "id": cid, "count": c.get("execution_count")})
        elif t == "status":
            emit({"type": "status", "id": cid, "state": c.get("execution_state")})

def shell_loop():
    while True:
        try:
            msg = kc.get_shell_msg(timeout=1)
        except queue.Empty:
            continue
        except Exception:
            break
        if msg["header"]["msg_type"] == "execute_reply":
            c = msg.get("content") or {}
            emit({"type": "reply", "id": cur(), "status": c.get("status"), "count": c.get("execution_count")})

threading.Thread(target=iopub_loop, daemon=True).start()
threading.Thread(target=shell_loop, daemon=True).start()

def _handle_cmd(cmd):
    ct = cmd.get("type")
    try:
        sys.stderr.write("[relay] recv %s\n" % ct)
        sys.stderr.flush()
    except Exception:
        pass
    if ct == "execute":
        # Record the cell id BEFORE executing, so any iopub output is attributed to
        # it (no race). Sequential execution guarantees one in-flight cell.
        with lock:
            current["id"] = cmd.get("id")
        kc.execute(cmd.get("code", ""))
    elif ct == "interrupt":
        try:
            km.interrupt_kernel()
        except Exception:
            pass
    elif ct == "restart":
        try:
            km.restart_kernel(now=True)
            kc.wait_for_ready(timeout=180)
            emit({"type": "ready"})
        except Exception as e:
            emit({"type": "fatal", "error": "restart failed: %s" % e})
    return ct == "shutdown"

# Read commands as RAW bytes from fd 0 (os.read), NOT sys.stdin.readline(): over a
# remote SSH exec channel Python's text-mode stdin buffering can hold a small,
# newline-terminated command until more data arrives, hanging the cell right after
# 'ready'. os.read returns whatever bytes are available immediately.
_inbuf = b""
_stop = False
while not _stop:
    try:
        chunk = os.read(0, 65536)
    except Exception:
        break
    if not chunk:
        break  # stdin closed
    _inbuf += chunk
    while b"\n" in _inbuf:
        rawline, _inbuf = _inbuf.split(b"\n", 1)
        line = rawline.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line.decode("utf-8"))
        except Exception:
            continue
        if _handle_cmd(cmd):
            _stop = True
            break

try:
    kc.stop_channels()
except Exception:
    pass
try:
    km.shutdown_kernel(now=True)
except Exception:
    pass
`;
