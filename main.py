import base64
import mimetypes
import os
import atexit
import socket
import subprocess
import threading
import time
import webbrowser
from pathlib import Path

import requests
from flask import Flask, jsonify, render_template, request

BASE_URL = "http://localhost:3000"
DEFAULT_COUNTRY_CODE = os.getenv("DEFAULT_COUNTRY_CODE", "961")
NODE_PROCESS = None

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024


def normalize_to_whatsapp_id(raw_phone: str) -> str:
    """
    Convert user input into WhatsApp ID format expected by WPPConnect.
    Output example: 96181744432@c.us
    """
    if not raw_phone or not raw_phone.strip():
        raise ValueError("Phone number is required.")

    value = raw_phone.strip()
    if value.endswith("@c.us"):
        value = value[:-5]

    value = (
        value.replace(" ", "")
        .replace("-", "")
        .replace("(", "")
        .replace(")", "")
    )

    explicit_international = value.startswith("+") or value.startswith("00")
    if value.startswith("+"):
        value = value[1:]
    elif value.startswith("00"):
        value = value[2:]

    digits = "".join(ch for ch in value if ch.isdigit())
    if not digits:
        raise ValueError("Phone number must contain digits.")

    country_digits = "".join(ch for ch in DEFAULT_COUNTRY_CODE if ch.isdigit())
    if not country_digits:
        raise ValueError("DEFAULT_COUNTRY_CODE must contain digits.")

    if explicit_international or digits.startswith(country_digits):
        normalized_digits = digits
    else:
        local_digits = digits.lstrip("0")
        if not local_digits:
            raise ValueError("Phone number is invalid.")
        normalized_digits = f"{country_digits}{local_digits}"

    return f"{normalized_digits}@c.us"


def upload_to_data_url(uploaded_file) -> str:
    raw = uploaded_file.read()
    if not raw:
        raise ValueError("Selected media file is empty.")

    mime_type = uploaded_file.mimetype
    if not mime_type:
        mime_type, _ = mimetypes.guess_type(uploaded_file.filename or "")
    if not mime_type:
        mime_type = "application/octet-stream"

    b64 = base64.b64encode(raw).decode("utf-8")
    return f"data:{mime_type};base64,{b64}"


def call_node_api(method: str, endpoint: str, payload: dict | None = None, timeout: int = 10) -> dict:
    method = method.upper().strip()
    url = f"{BASE_URL}{endpoint}"

    try:
        if method == "GET":
            response = requests.get(url, timeout=timeout)
        elif method == "POST":
            response = requests.post(url, json=payload, timeout=timeout)
        else:
            raise RuntimeError(f"Unsupported HTTP method: {method}")
    except requests.RequestException as exc:
        raise RuntimeError(f"Failed to reach WhatsApp API: {exc}") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError("WhatsApp API returned a non-JSON response.") from exc

    if not response.ok:
        if isinstance(data, dict):
            raise RuntimeError(
                data.get("error") or f"WhatsApp API failed with status {response.status_code}."
            )
        raise RuntimeError(f"WhatsApp API failed with status {response.status_code}.")

    return data


def post_json(endpoint: str, payload: dict, timeout: int) -> dict:
    data = call_node_api("POST", endpoint, payload=payload, timeout=timeout)
    if not data.get("ok"):
        raise RuntimeError(data.get("error") or "Unknown error from WhatsApp API.")
    return data


def send_text(to: str, message: str) -> None:
    post_json(
        endpoint="/send-text",
        payload={"to": to, "message": message},
        timeout=10,
    )


def send_media(to: str, filename: str, caption: str, data_url: str) -> None:
    post_json(
        endpoint="/send-media",
        payload={
            "to": to,
            "filename": filename,
            "caption": caption,
            "base64": data_url,
        },
        timeout=120,
    )


@app.get("/")
def home():
    return render_template("index.html", default_country_code=DEFAULT_COUNTRY_CODE)


@app.post("/api/auth/start")
def api_auth_start():
    try:
        data = call_node_api("POST", "/auth/start", payload={}, timeout=10)
        if not data.get("ok"):
            raise RuntimeError(data.get("error") or "Failed to start WhatsApp login.")
        return jsonify(data)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.get("/api/auth/status")
def api_auth_status():
    try:
        data = call_node_api("GET", "/auth/status", timeout=10)
        if not data.get("ok"):
            raise RuntimeError(data.get("error") or "Failed to read WhatsApp status.")
        return jsonify(data)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.post("/api/send")
def api_send():
    phone = request.form.get("phone", "").strip()
    message = request.form.get("message", "").strip()
    uploaded_file = request.files.get("media")

    try:
        to = normalize_to_whatsapp_id(phone)
        has_media = bool(uploaded_file and uploaded_file.filename)
        has_message = bool(message)

        if not has_message and not has_media:
            raise ValueError("Write a message or choose a media file.")

        if has_media:
            data_url = upload_to_data_url(uploaded_file)
            send_media(
                to=to,
                filename=uploaded_file.filename,
                caption=message,
                data_url=data_url,
            )
            return jsonify(
                {
                    "ok": True,
                    "message": f"Media sent to {to}. You are logged out; a new QR code will be required next send.",
                }
            )

        send_text(to=to, message=message)
        return jsonify(
            {
                "ok": True,
                "message": f"Text sent to {to}. You are logged out; a new QR code will be required next send.",
            }
        )
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 500


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


def start_node_server(api_port: int) -> subprocess.Popen:
    env = os.environ.copy()
    env["API_PORT"] = str(api_port)

    project_root = Path(__file__).resolve().parent
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


def stop_node_server() -> None:
    global NODE_PROCESS
    process = NODE_PROCESS
    NODE_PROCESS = None

    if not process:
        return

    if process.poll() is not None:
        return

    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def wait_for_node_ready(base_url: str, timeout_seconds: int = 20) -> None:
    deadline = time.time() + timeout_seconds
    last_error = None

    while time.time() < deadline:
        if NODE_PROCESS and NODE_PROCESS.poll() is not None:
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


if __name__ == "__main__":
    preferred_api_port = int(os.getenv("API_PORT", "3000"))
    api_port = find_available_port(preferred_api_port)

    BASE_URL = f"http://127.0.0.1:{api_port}"
    NODE_PROCESS = start_node_server(api_port)
    atexit.register(stop_node_server)
    wait_for_node_ready(BASE_URL)

    preferred_ui_port = int(os.getenv("FLASK_PORT", "5000"))
    ui_port = find_available_port(preferred_ui_port)
    debug_mode = os.getenv("FLASK_DEBUG", "1") == "1"
    ui_url = f"http://127.0.0.1:{ui_port}"

    print(f"Node API running on: {BASE_URL}")
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
        stop_node_server()
