from flask import jsonify


class AppError(Exception):
    """Application-level error carrying code, message, HTTP status, and details."""

    def __init__(self, code: str, message: str, status: int = 500, details: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details


def json_error(code: str, message: str, status: int, details: str | None = None):
    """Build a consistent JSON error payload for API responses."""
    payload = {"ok": False, "error_code": code, "error": message}
    if details:
        payload["details"] = details
    return jsonify(payload), status


def handle_api_exception(exc: Exception):
    """Convert any exception to a normalized JSON error response."""
    if isinstance(exc, AppError):
        return json_error(exc.code, exc.message, exc.status, exc.details)
    return json_error(
        code="UNEXPECTED_SERVER_ERROR",
        message="Unexpected server error. Please try again.",
        status=500,
        details=str(exc),
    )
