import requests
from requests import exceptions as requests_exceptions

from .errors import AppError


def _safe_http_status(status_code: int) -> int:
    """Keep real 4xx/5xx codes; fallback to 502 when status is invalid."""
    return status_code if 400 <= status_code <= 599 else 502


# Core client for communicating with the Node.js WhatsApp API service.
def map_node_error(status_code: int, raw_error: str | None = None) -> AppError:
    details = raw_error or ""
    lowered = details.lower()
    safe_status = _safe_http_status(status_code)

    if "wpp is not defined" in lowered:
        return AppError(
            code="WHATSAPP_WPP_MISSING",
            message=(
                "WhatsApp Web did not finish initializing (\"WPP is not defined\"). "
                "Wait 5-10 seconds and retry. If it repeats, click Logout or restart python main.py."
            ),
            status=503,
            details=details,
        )

    if (
        "browser is already running" in lowered
        or "userdatadir" in lowered
        or "singletonlock" in lowered
    ):
        return AppError(
            code="BROWSER_PROFILE_LOCKED",
            message=(
                "WhatsApp browser profile is locked by another running browser process. "
                "Close Chrome/Edge processes using this session, then try Send again."
            ),
            status=409,
            details=details,
        )

    if "spawn eperm" in lowered or "error no open browser" in lowered:
        return AppError(
            code="WHATSAPP_BROWSER_LAUNCH_FAILED",
            message=(
                "WhatsApp browser could not start due to a local permission/system restriction. "
                "Restart the app, allow Node/Chrome in antivirus, and try again."
            ),
            status=503,
            details=details,
        )

    # Heuristic mapping of Node API errors to user-friendly messages and status codes.
    if "not ready" in lowered or safe_status == 503:
        return AppError(
            code="WHATSAPP_NOT_READY",
            message=(
                "WhatsApp is not ready yet. Keep the QR window open, scan it with your phone, "
                "and wait for \"Login confirmed\" before sending."
            ),
            status=503,
            details=details,
        )

    # The Node API may return 200 with an error message in some cases, so also check the content.
    if "timed out" in lowered:
        return AppError(
            code="DELIVERY_TIMEOUT",
            message=(
                "Delivery timed out while waiting for WhatsApp acknowledgment. "
                "Check internet stability, wait a few seconds, then retry."
            ),
            status=504,
            details=details,
        )

    # "ack failed" is a common error indicating delivery failure, often due to an invalid number.
    if "ack failed" in lowered:
        return AppError(
            code="DELIVERY_FAILED",
            message=(
                "WhatsApp did not confirm delivery for this number. "
                "Verify the number format and that the target has WhatsApp, then try again."
            ),
            status=502,
            details=details,
        )

    # 413 Payload Too Large is a common response when media exceeds limits.
    if safe_status == 413 or "too large" in lowered:
        return AppError(
            code="MEDIA_TOO_LARGE",
            message=(
                "Selected media is too large for WhatsApp delivery in this request. "
                "Compress the media or choose a smaller file."
            ),
            status=413,
            details=details,
        )

    if "missing \"to\" or \"message\"" in lowered or safe_status == 400:
        return AppError(
            code="NODE_API_BAD_REQUEST",
            message=(
                "WhatsApp service rejected the request data. "
                "Check phone number format, message text, and media fields, then retry."
            ),
            status=400,
            details=details,
        )

    if safe_status == 401:
        return AppError(
            code="NODE_API_UNAUTHORIZED",
            message=(
                "WhatsApp session is not authorized. Start login again and scan a fresh QR code."
            ),
            status=401,
            details=details,
        )

    if safe_status == 403:
        return AppError(
            code="NODE_API_FORBIDDEN",
            message=(
                "WhatsApp service denied this operation. Re-login and try again."
            ),
            status=403,
            details=details,
        )

    if safe_status == 404:
        return AppError(
            code="NODE_API_ROUTE_NOT_FOUND",
            message=(
                "Internal WhatsApp API route was not found. Restart python main.py "
                "to reload matching Flask/Node versions."
            ),
            status=404,
            details=details,
        )

    if safe_status == 409:
        return AppError(
            code="NODE_API_CONFLICT",
            message=(
                "WhatsApp session is in a conflicting state. Wait a few seconds and retry. "
                "If it repeats, restart the app."
            ),
            status=409,
            details=details,
        )

    if safe_status == 429:
        return AppError(
            code="NODE_API_RATE_LIMIT",
            message=(
                "Too many requests were sent to WhatsApp too quickly. "
                "Wait 30-60 seconds, then try again."
            ),
            status=429,
            details=details,
        )

    if 500 <= safe_status <= 599:
        return AppError(
            code="NODE_API_SERVER_ERROR",
            message=(
                "WhatsApp service had an internal failure. "
                "Retry once; if it repeats, restart python main.py."
            ),
            status=safe_status,
            details=details,
        )

    # Keep status code accuracy instead of forcing everything to 500.
    return AppError(
        code="WHATSAPP_API_ERROR",
        message=(
            "WhatsApp service returned an unexpected error. "
            "Retry once; if it continues, restart python main.py."
        ),
        status=safe_status,
        details=details,
    )

# The NodeApiClient encapsulates all interactions with the Node.js API, including error handling and response parsing.
class NodeApiClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    # Allow updating the base URL if the Node server starts on a different port than initially expected.
    def set_base_url(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    # call_api is a low-level method that handles making HTTP requests to the Node API, parsing responses, and mapping errors to AppError exceptions.
    def call_api(self, method: str, endpoint: str, payload: dict | None = None, timeout: int = 10) -> dict:
        method = method.upper().strip()
        url = f"{self.base_url}{endpoint}"

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
            raise map_node_error(status_code=response.status_code, raw_error=raw_error)

        return data

    # post_json is a helper method for making POST requests to the Node API and automatically checking for success or raising an AppError with mapped messages.
    def post_json(self, endpoint: str, payload: dict, timeout: int) -> dict:
        data = self.call_api("POST", endpoint, payload=payload, timeout=timeout)
        if not data.get("ok"):
            raise map_node_error(status_code=502, raw_error=data.get("error"))
        return data

    # The following methods are high-level abstractions for specific API actions, such as sending text or media messages, and they utilize the underlying call_api method for communication and error handling.
    def send_text(self, to: str, message: str, keep_session: bool = False) -> None:
        self.post_json(
            endpoint="/send-text",
            payload={"to": to, "message": message, "keepSession": keep_session},
            timeout=10,
        )

    def send_media(
        self,
        to: str,
        filename: str,
        caption: str,
        data_url: str,
        keep_session: bool = False,
    ) -> None:
        self.post_json(
            endpoint="/send-media",
            payload={
                "to": to,
                "filename": filename,
                "caption": caption,
                "base64": data_url,
                "keepSession": keep_session,
            },
            timeout=120,
        )

    # logout_session is a method to explicitly close the WhatsApp session after sending messages, which can help free up resources and avoid hitting session limits on the Node API side.
    def logout_session(self) -> None:
        data = self.call_api("POST", "/session/logout", payload={}, timeout=20)
        if not data.get("ok"):
            raise AppError(
                code="LOGOUT_FAILED",
                message="Failed to close WhatsApp session after sending.",
                status=502,
                details=data.get("error"),
            )
