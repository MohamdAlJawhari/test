import requests
from requests import exceptions as requests_exceptions

from .errors import AppError


def map_node_error(status_code: int, raw_error: str | None = None) -> AppError:
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


class NodeApiClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def set_base_url(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

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

    def post_json(self, endpoint: str, payload: dict, timeout: int) -> dict:
        data = self.call_api("POST", endpoint, payload=payload, timeout=timeout)
        if not data.get("ok"):
            raise map_node_error(status_code=502, raw_error=data.get("error"))
        return data

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

    def logout_session(self) -> None:
        data = self.call_api("POST", "/session/logout", payload={}, timeout=20)
        if not data.get("ok"):
            raise AppError(
                code="LOGOUT_FAILED",
                message="Failed to close WhatsApp session after sending.",
                status=502,
                details=data.get("error"),
            )

