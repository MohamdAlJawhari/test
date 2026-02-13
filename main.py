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
from requests import exceptions as requests_exceptions

BASE_URL = "http://localhost:3000"
DEFAULT_COUNTRY_CODE = os.getenv("DEFAULT_COUNTRY_CODE", "961")
NODE_PROCESS = None

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024


class AppError(Exception):
    def __init__(self, code: str, message: str, status: int = 500, details: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details


def _json_error(code: str, message: str, status: int, details: str | None = None):
    payload = {"ok": False, "error_code": code, "error": message}
    if details:
        payload["details"] = details
    return jsonify(payload), status


def _handle_api_exception(exc: Exception):
    if isinstance(exc, AppError):
        return _json_error(exc.code, exc.message, exc.status, exc.details)
    return _json_error(
        code="UNEXPECTED_SERVER_ERROR",
        message="Unexpected server error. Please try again.",
        status=500,
        details=str(exc),
    )


def _map_node_error(status_code: int, raw_error: str | None = None) -> AppError:
    details = raw_error or ""
    lowered = details.lower()

    if "not ready" in lowered or status_code == 503:
        return AppError(
            code="WHATSAPP_NOT_READY",
            message="WhatsApp is not ready yet. Keep the QR window open and scan again.",
            status=503,
            details=details,
        )

    if "timed out" in lowered:
        return AppError(
            code="DELIVERY_TIMEOUT",
            message="The connection is slow. Sending is taking longer than expected. It may still arrive.",
            status=504,
            details=details,
        )

    if "ack failed" in lowered:
        return AppError(
            code="DELIVERY_FAILED",
            message="Message delivery failed. Please verify the number and try again.",
            status=502,
            details=details,
        )

    if status_code == 413:
        return AppError(
            code="MEDIA_TOO_LARGE",
            message="Selected media is too large for this request. Try a smaller file.",
            status=413,
            details=details,
        )

    return AppError(
        code="WHATSAPP_API_ERROR",
        message="WhatsApp service returned an error. Please try again.",
        status=max(status_code, 500),
        details=details,
    )


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
            raise AppError(
                code="INVALID_METHOD",
                message="Internal server configuration error.",
                status=500,
                details=f"Unsupported HTTP method: {method}",
            )
    except requests_exceptions.Timeout as exc:
        raise AppError(
            code="NODE_API_TIMEOUT",
            message="WhatsApp service is taking too long to respond. Check your connection and try again.",
            status=504,
            details=str(exc),
        ) from exc
    except requests_exceptions.ConnectionError as exc:
        raise AppError(
            code="NODE_API_UNREACHABLE",
            message="Cannot connect to WhatsApp service. Wait a few seconds and try again.",
            status=503,
            details=str(exc),
        ) from exc
    except requests_exceptions.RequestException as exc:
        raise AppError(
            code="NODE_API_REQUEST_ERROR",
            message="Network error while contacting WhatsApp service.",
            status=502,
            details=str(exc),
        ) from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise AppError(
            code="NODE_API_BAD_RESPONSE",
            message="WhatsApp service returned an unexpected response.",
            status=502,
            details=str(exc),
        ) from exc

    if not response.ok:
        raw_error = data.get("error") if isinstance(data, dict) else None
        raise _map_node_error(status_code=response.status_code, raw_error=raw_error)

    return data


def post_json(endpoint: str, payload: dict, timeout: int) -> dict:
    data = call_node_api("POST", endpoint, payload=payload, timeout=timeout)
    if not data.get("ok"):
        raise _map_node_error(status_code=502, raw_error=data.get("error"))
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
            raise AppError(
                code="AUTH_START_FAILED",
                message="Failed to start WhatsApp login.",
                status=502,
                details=data.get("error"),
            )
        return jsonify(data)
    except Exception as exc:
        return _handle_api_exception(exc)


@app.get("/api/auth/status")
def api_auth_status():
    try:
        data = call_node_api("GET", "/auth/status", timeout=10)
        if not data.get("ok"):
            raise AppError(
                code="AUTH_STATUS_FAILED",
                message="Failed to read WhatsApp login status.",
                status=502,
                details=data.get("error"),
            )
        return jsonify(data)
    except Exception as exc:
        return _handle_api_exception(exc)


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
            raise AppError(
                code="MISSING_CONTENT",
                message="Write a message or choose a media file.",
                status=400,
            )

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
        return _json_error(
            code="VALIDATION_ERROR",
            message=str(exc),
            status=400,
        )
    except Exception as exc:
        return _handle_api_exception(exc)


@app.errorhandler(413)
def handle_payload_too_large(_exc):
    return _json_error(
        code="MEDIA_TOO_LARGE",
        message="Selected media is too large. Choose a smaller file and try again.",
        status=413,
    )


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
