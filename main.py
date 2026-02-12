import base64
import mimetypes
import os

import requests
from flask import Flask, jsonify, render_template, request

BASE_URL = "http://localhost:3000"
DEFAULT_COUNTRY_CODE = os.getenv("DEFAULT_COUNTRY_CODE", "961")

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
        timeout=30,
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


if __name__ == "__main__":
    port = int(os.getenv("FLASK_PORT", "8000"))
    debug_mode = os.getenv("FLASK_DEBUG", "1") == "1"
    app.run(host="127.0.0.1", port=port, debug=debug_mode)
