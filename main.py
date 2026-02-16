import atexit
import datetime
import os
import threading
import time
import traceback

from flask import Flask, jsonify, request

from app_core.config import MAX_CONTENT_LENGTH, PROJECT_ROOT, RESOURCE_ROOT
from app_core.node_api import NodeApiClient
from app_core.routes import register_routes
from app_core.runtime import (
    find_available_port,
    open_browser_soon,
    start_node_server,
    stop_node_server,
    wait_for_node_ready,
)

# Entry point module: wires Flask app + route registration + Node process lifecycle.
app = Flask(
    __name__,
    static_folder=str(RESOURCE_ROOT / "static"),
    template_folder=str(RESOURCE_ROOT / "templates"),
)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

node_api = NodeApiClient(base_url="http://localhost:3000")
register_routes(app, node_api=node_api)

NODE_PROCESS = None
UI_SERVER = None
SHUTDOWN_EVENT = threading.Event()
TAB_ACTIVITY_LOCK = threading.Lock()
TAB_LAST_SEEN: dict[str, float] = {}
LAST_BROWSER_ACTIVITY_AT = time.monotonic()
WATCHDOG_START_AT = time.monotonic()
HAS_SEEN_BROWSER = False

BROWSER_IDLE_TIMEOUT_SECONDS = max(
    5,
    int(os.getenv("BROWSER_IDLE_TIMEOUT_SECONDS", "8")),
)
BROWSER_STARTUP_GRACE_SECONDS = max(
    8,
    int(os.getenv("BROWSER_STARTUP_GRACE_SECONDS", "20")),
)
BROWSER_HEARTBEAT_STALE_SECONDS = max(
    BROWSER_IDLE_TIMEOUT_SECONDS + 3,
    int(
        os.getenv(
            "BROWSER_HEARTBEAT_STALE_SECONDS",
            str(BROWSER_IDLE_TIMEOUT_SECONDS + 6),
        )
    ),
)


def _sanitize_tab_id(raw_value: object) -> str:
    if not isinstance(raw_value, str):
        return ""
    tab_id = raw_value.strip()
    if not tab_id or len(tab_id) > 128:
        return ""
    return tab_id


def _prune_stale_tabs(now_mono: float) -> None:
    stale_before = now_mono - BROWSER_HEARTBEAT_STALE_SECONDS
    stale_ids = [tab_id for tab_id, last_seen in TAB_LAST_SEEN.items() if last_seen < stale_before]
    for tab_id in stale_ids:
        TAB_LAST_SEEN.pop(tab_id, None)


def _record_browser_activity(tab_id: str) -> None:
    global HAS_SEEN_BROWSER, LAST_BROWSER_ACTIVITY_AT
    now_mono = time.monotonic()
    with TAB_ACTIVITY_LOCK:
        HAS_SEEN_BROWSER = True
        LAST_BROWSER_ACTIVITY_AT = now_mono
        if tab_id:
            TAB_LAST_SEEN[tab_id] = now_mono


def _remove_browser_tab(tab_id: str) -> None:
    if not tab_id:
        return
    with TAB_ACTIVITY_LOCK:
        TAB_LAST_SEEN.pop(tab_id, None)


def _request_ui_shutdown(reason: str) -> None:
    global UI_SERVER
    if SHUTDOWN_EVENT.is_set():
        return

    SHUTDOWN_EVENT.set()
    print(f"Stopping UI server ({reason}).")

    if UI_SERVER is not None:
        try:
            UI_SERVER.close()
        except Exception as exc:
            print(f"UI server close warning: {exc}")


def _browser_watchdog_loop() -> None:
    while not SHUTDOWN_EVENT.is_set():
        now_mono = time.monotonic()

        with TAB_ACTIVITY_LOCK:
            _prune_stale_tabs(now_mono)
            active_tabs = len(TAB_LAST_SEEN)
            idle_for_seconds = now_mono - LAST_BROWSER_ACTIVITY_AT
            has_seen_browser = HAS_SEEN_BROWSER

        startup_age_seconds = now_mono - WATCHDOG_START_AT
        startup_or_session_ready = has_seen_browser or (
            startup_age_seconds >= BROWSER_STARTUP_GRACE_SECONDS
        )

        if (
            startup_or_session_ready
            and active_tabs == 0
            and idle_for_seconds >= BROWSER_IDLE_TIMEOUT_SECONDS
        ):
            _request_ui_shutdown(
                "no browser heartbeat detected; all UI windows appear closed"
            )
            return

        time.sleep(1.5)


@app.post("/api/runtime/heartbeat")
def api_runtime_heartbeat():
    payload = request.get_json(silent=True) or {}
    tab_id = _sanitize_tab_id(payload.get("tabId"))
    _record_browser_activity(tab_id)
    return jsonify({"ok": True})


@app.post("/api/runtime/browser-closed")
def api_runtime_browser_closed():
    payload = request.get_json(silent=True) or {}
    tab_id = _sanitize_tab_id(payload.get("tabId"))
    _remove_browser_tab(tab_id)
    return jsonify({"ok": True})


def _write_crash_log(trace_text: str) -> str:
    """Write a crash log next to the executable/project and return its path as text."""
    log_path = PROJECT_ROOT / "crash.log"
    try:
        timestamp = datetime.datetime.now().isoformat(timespec="seconds")
        log_path.write_text(
            f"[{timestamp}]\n{trace_text}\n",
            encoding="utf-8",
        )
    except OSError:
        pass
    return str(log_path)


def _show_windows_error(title: str, message: str) -> bool:
    if os.name != "nt":
        return False
    try:
        import ctypes

        MB_ICONERROR = 0x10
        ctypes.windll.user32.MessageBoxW(0, message, title, MB_ICONERROR)
        return True
    except Exception:
        return False


def _stop_node_process() -> None:
    """Safely stop the background Node.js API process if it is running."""
    global NODE_PROCESS
    stop_node_server(NODE_PROCESS, base_url=node_api.base_url)
    NODE_PROCESS = None


if __name__ == "__main__":
    try:
        # Start the Node API on an available port.
        preferred_api_port = int(os.getenv("API_PORT", "3000"))
        api_port = find_available_port(preferred_api_port)
        node_api.set_base_url(f"http://127.0.0.1:{api_port}")

        NODE_PROCESS = start_node_server(api_port=api_port, project_root=PROJECT_ROOT)
        atexit.register(_stop_node_process)
        wait_for_node_ready(node_api.base_url, process=NODE_PROCESS)

        # Start Flask UI on an available port and open browser.
        preferred_ui_port = int(os.getenv("FLASK_PORT", "5000"))
        ui_port = find_available_port(preferred_ui_port)
        debug_mode = os.getenv("FLASK_DEBUG", "0") == "1"
        ui_url = f"http://127.0.0.1:{ui_port}"
        WATCHDOG_START_AT = time.monotonic()

        print(f"Node API running on: {node_api.base_url}")
        print(f"Opening UI on: {ui_url}")
        open_browser_soon(ui_url)

        if debug_mode:
            print("Debug mode enabled. Browser-close auto-shutdown is disabled.")
            app.run(
                host="127.0.0.1",
                port=ui_port,
                debug=True,
                use_reloader=False,
            )
        else:
            from waitress import create_server

            UI_SERVER = create_server(app, host="127.0.0.1", port=ui_port)
            watchdog_thread = threading.Thread(
                target=_browser_watchdog_loop,
                name="browser-heartbeat-watchdog",
                daemon=True,
            )
            watchdog_thread.start()
            UI_SERVER.run()
    except Exception as exc:
        trace_text = traceback.format_exc()
        crash_log_path = _write_crash_log(trace_text)
        message = (
            "WhatsAppSender failed to start.\n\n"
            f"{exc}\n\n"
            f"Details were written to:\n{crash_log_path}"
        )
        if not _show_windows_error("WhatsAppSender", message):
            print(message)
            try:
                input("Press Enter to close...")
            except EOFError:
                pass
    finally:
        _request_ui_shutdown("process exiting")
        _stop_node_process()
