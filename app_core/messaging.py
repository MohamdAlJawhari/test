import base64
import mimetypes
import re

from .config import DEFAULT_COUNTRY_CODE
from .errors import AppError

PLACEHOLDER_PATTERN = re.compile(r"{{\s*([^{}]+?)\s*}}")


def normalize_to_whatsapp_id(raw_phone: str) -> str:
    """
    Convert user input into WhatsApp ID format expected by WPPConnect.
    Output example: 96181777444@c.us
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


def render_message_template(template: str, row_map: dict) -> str:
    if not template:
        return ""

    lookup = {str(key).strip().lower(): str(value) for key, value in row_map.items()}
    missing_keys: set[str] = set()

    def replace(match: re.Match) -> str:
        raw_key = match.group(1).strip()
        key = raw_key.lower()
        if key in lookup:
            return lookup[key]
        missing_keys.add(raw_key)
        return match.group(0)

    rendered = PLACEHOLDER_PATTERN.sub(replace, template)
    if missing_keys:
        row_ref = row_map.get("__row_index", "?")
        raise AppError(
            code="MISSING_TEMPLATE_VARIABLE",
            message=f"Missing column(s) in contacts file for placeholders: {', '.join(sorted(missing_keys))}.",
            status=400,
            details=f"Row {row_ref}",
        )

    return rendered

