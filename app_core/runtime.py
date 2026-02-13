import os
import socket
import subprocess
import threading
import time
import webbrowser
from pathlib import Path

import requests


def is_port_available(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def find_available_port(preferred_port: int) -> int:
    if preferred_port > 0 and is_port_available(preferred_port):
        return preferred_port

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def start_node_server(api_port: int, project_root: Path) -> subprocess.Popen:
    env = os.environ.copy()
    env["API_PORT"] = str(api_port)

    try:
        process = subprocess.Popen(
            ["node", "index.js"],
            cwd=project_root,
            env=env,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            'Node.js is not available in PATH. Install Node.js or run "node index.js" manually.'
        ) from exc

    return process


def stop_node_server(process: subprocess.Popen | None) -> None:
    if not process:
        return

    if process.poll() is not None:
        return

    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def wait_for_node_ready(
    base_url: str,
    process: subprocess.Popen | None = None,
    timeout_seconds: int = 20,
) -> None:
    deadline = time.time() + timeout_seconds
    last_error = None

    while time.time() < deadline:
        if process and process.poll() is not None:
            raise RuntimeError("Node API process exited before becoming ready.")

        try:
            response = requests.get(f"{base_url}/auth/status", timeout=1.5)
            if response.ok:
                return
        except requests.RequestException as exc:
            last_error = exc

        time.sleep(0.4)

    raise RuntimeError(
        f"Node API did not become ready on {base_url} within {timeout_seconds} seconds."
        + (f" Last error: {last_error}" if last_error else "")
    )


def open_browser_soon(url: str, delay_seconds: float = 0.8) -> None:
    timer = threading.Timer(delay_seconds, lambda: webbrowser.open(url))
    timer.daemon = True
    timer.start()

