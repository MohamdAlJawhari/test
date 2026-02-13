import atexit
import os

from flask import Flask

from app_core.config import MAX_CONTENT_LENGTH, PROJECT_ROOT
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
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH

node_api = NodeApiClient(base_url="http://localhost:3000")
register_routes(app, node_api=node_api)

NODE_PROCESS = None


def _stop_node_process() -> None:
    """Safely stop the background Node.js API process if it is running."""
    global NODE_PROCESS
    stop_node_server(NODE_PROCESS)
    NODE_PROCESS = None


if __name__ == "__main__":
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
    debug_mode = os.getenv("FLASK_DEBUG", "1") == "1"
    ui_url = f"http://127.0.0.1:{ui_port}"

    print(f"Node API running on: {node_api.base_url}")
    print(f"Opening UI on: {ui_url}")
    open_browser_soon(ui_url)

    try:
        app.run(
            host="127.0.0.1",
            port=ui_port,
            debug=debug_mode,
            use_reloader=False,
        )
    finally:
        _stop_node_process()
