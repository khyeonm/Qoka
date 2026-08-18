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
import sys, os, json, signal, threading, queue, subprocess, tempfile

def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj) + "\n")
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
try:
    # Isolate the kernel's own stdio from OUR stdout (which carries the JSON
    # protocol). Its stdout goes to DEVNULL so kernel prints can't corrupt our
    # "ready"/output lines; its STDERR is captured to a file so that if the kernel
    # crashes on startup (why "launching kernel" would hang) we can report the reason.
    # Cell stdout/stderr still comes back over ZMQ (iopub), not these pipes.
    try:
        _kerr = tempfile.NamedTemporaryFile(mode="w+", suffix=".qoka-kernel-err", delete=False)
        _kerr_path = _kerr.name
        km.start_kernel(stdout=subprocess.DEVNULL, stderr=_kerr)
    except TypeError:
        km.start_kernel()
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=180)
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

while True:
    raw = sys.stdin.readline()
    if not raw:
        break
    line = raw.strip()
    if not line:
        continue
    try:
        cmd = json.loads(line)
    except Exception:
        continue
    ct = cmd.get("type")
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
    elif ct == "shutdown":
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
