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
 * into a per-project uv venv.
 */
export const RELAY_PY = String.raw`
import sys, json, threading, queue

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
try:
    km.start_kernel()
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=180)
except Exception as e:
    emit({"type": "fatal", "error": "kernel start failed: %s" % e})
    sys.exit(1)

emit({"type": "ready"})

# kernel message-id -> our cell id
cells = {}
lock = threading.Lock()

def iopub_loop():
    while True:
        try:
            msg = kc.get_iopub_msg(timeout=1)
        except queue.Empty:
            continue
        except Exception:
            break
        parent = (msg.get("parent_header") or {}).get("msg_id")
        with lock:
            cid = cells.get(parent)
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
            parent = (msg.get("parent_header") or {}).get("msg_id")
            with lock:
                cid = cells.pop(parent, None)
            c = msg.get("content") or {}
            emit({"type": "reply", "id": cid, "status": c.get("status"), "count": c.get("execution_count")})

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
        mid = kc.execute(cmd.get("code", ""))
        with lock:
            cells[mid] = cmd.get("id")
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
