import os
from pathlib import Path

# Central configuration/constants used by routes and services.
DEFAULT_COUNTRY_CODE = os.getenv("DEFAULT_COUNTRY_CODE", "961")
BATCH_SEND_DELAY_SECONDS = float(os.getenv("BATCH_SEND_DELAY_SECONDS", "0.8"))
DEFAULT_MESSAGE_TEXT = "Hello {{name}}, your password is {{password}}."

PROJECT_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_FILE_PATH = PROJECT_ROOT / "template.txt"

CONTACTS_UPLOAD_DIR = PROJECT_ROOT / "data" / "contacts_uploads"
CONTACTS_METADATA_FILE = CONTACTS_UPLOAD_DIR / "metadata.json"

ALLOWED_EXCEL_EXTENSIONS = {".xlsx", ".xlsm", ".xltx", ".xltm"}
ALLOWED_CONTACT_EXTENSIONS = ALLOWED_EXCEL_EXTENSIONS | {".csv"}

CONTACTS_PREVIEW_ROW_LIMIT = int(os.getenv("CONTACTS_PREVIEW_ROW_LIMIT", "20"))
CONTACTS_PREVIEW_COLUMN_LIMIT = int(os.getenv("CONTACTS_PREVIEW_COLUMN_LIMIT", "15"))

MAX_CONTENT_LENGTH = 50 * 1024 * 1024


def load_default_message_template() -> str:
    """Read default message text from template file, with safe fallback."""
    try:
        if TEMPLATE_FILE_PATH.exists():
            file_text = TEMPLATE_FILE_PATH.read_text(encoding="utf-8")
            return file_text.replace("\r\n", "\n").replace("\r", "\n")
    except OSError:
        pass
    return DEFAULT_MESSAGE_TEXT


def save_default_message_template(template_text: str) -> None:
    TEMPLATE_FILE_PATH.write_text(template_text, encoding="utf-8")
