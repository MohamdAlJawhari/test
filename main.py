import base64
import mimetypes
import os

import requests
from flask import Flask, render_template, request

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


def post_json(endpoint: str, payload: dict, timeout: int) -> dict:
    try:
        response = requests.post(
            f"{BASE_URL}{endpoint}",
            json=payload,
            timeout=timeout,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError(f"Failed to reach WhatsApp API: {exc}") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError("WhatsApp API returned a non-JSON response.") from exc

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


@app.route("/", methods=["GET", "POST"])
def home():
    form_values = {"phone": "", "message": ""}
    status_message = None
    status_error = False

    if request.method == "POST":
        form_values["phone"] = request.form.get("phone", "").strip()
        form_values["message"] = request.form.get("message", "").strip()
        uploaded_file = request.files.get("media")

        try:
            to = normalize_to_whatsapp_id(form_values["phone"])
            has_media = bool(uploaded_file and uploaded_file.filename)
            has_message = bool(form_values["message"])

            if not has_message and not has_media:
                raise ValueError("Write a message or choose a media file.")

            if has_media:
                data_url = upload_to_data_url(uploaded_file)
                send_media(
                    to=to,
                    filename=uploaded_file.filename,
                    caption=form_values["message"],
                    data_url=data_url,
                )
                status_message = f"Media sent to {to}."
            else:
                send_text(to=to, message=form_values["message"])
                status_message = f"Text sent to {to}."
        except Exception as exc:
            status_error = True
            status_message = str(exc)

    return render_template(
        "index.html",
        form_values=form_values,
        status_message=status_message,
        status_error=status_error,
        default_country_code=DEFAULT_COUNTRY_CODE,
    )


if __name__ == "__main__":
    port = int(os.getenv("FLASK_PORT", "8000"))
    debug_mode = os.getenv("FLASK_DEBUG", "1") == "1"
    app.run(host="127.0.0.1", port=port, debug=debug_mode)
