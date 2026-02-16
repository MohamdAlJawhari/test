import os
import socket
import subprocess
import threading
import time
import webbrowser
from pathlib import Path

import requests

# find_node_executable resolves a Node.js executable path. This enables shipping a portable `node.exe` alongside the app.
def find_node_executable(project_root: Path) -> str:
    env_node = os.getenv("NODE_EXE")
    if env_node:
        return env_node

    candidates: list[Path] = []
    if os.name == "nt":
        candidates.extend(
            [
                project_root / "node.exe",
                project_root / "node" / "node.exe",
                project_root / "runtime" / "node.exe",
            ]
        )
    else:
        candidates.extend(
            [
                project_root / "node",
                project_root / "node" / "bin" / "node",
                project_root / "runtime" / "node",
            ]
        )

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    return "node"

# Core runtime utilities for managing the Node.js API process, checking port availability, and opening the browser.
def is_port_available(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False

# find_available_port checks if the preferred port is available, and if not, it finds a random available port by binding to port 0.
def find_available_port(preferred_port: int) -> int:
    if preferred_port > 0 and is_port_available(preferred_port):
        return preferred_port

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])

# start_node_server starts the Node.js API server as a subprocess, passing the API port via environment variables, and returns the process handle for later management.
def start_node_server(api_port: int, project_root: Path) -> subprocess.Popen:
    env = os.environ.copy()
    env["API_PORT"] = str(api_port)

    try:
        node_exe = find_node_executable(project_root)
        process = subprocess.Popen(
            [node_exe, "index.js"],
            cwd=project_root,
            env=env,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            'Node.js is not available. Install Node.js, add it to PATH, or set NODE_EXE to a Node executable path.'
        ) from exc

    return process

# stop_node_server safely terminates the Node.js API subprocess, first trying a graceful shutdown and then force-killing if it does not exit within a timeout.
def stop_node_server(process: subprocess.Popen | None, base_url: str | None = None) -> None:
    if not process:
        return

    if process.poll() is not None:
        return

    if base_url:
        try:
            requests.post(f"{base_url}/system/shutdown", json={}, timeout=4)
            process.wait(timeout=8)
            return
        except (requests.RequestException, subprocess.TimeoutExpired):
            pass

    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            # Kill the full process tree to avoid orphaned Chrome/Node child processes.
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            try:
                process.wait(timeout=3)
                return
            except subprocess.TimeoutExpired:
                pass

        process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass


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

# open_browser_soon uses a background timer thread to open the default web browser to the specified URL after a short delay, allowing the server to start first.
def open_browser_soon(url: str, delay_seconds: float = 0.8) -> None:
    timer = threading.Timer(delay_seconds, lambda: webbrowser.open(url))
    timer.daemon = True
    timer.start()
