import mimetypes
import time
from datetime import datetime
from pathlib import Path

from flask import jsonify, render_template, request, send_file

from .config import BATCH_SEND_DELAY_SECONDS, DEFAULT_COUNTRY_CODE, load_default_message_template
from .contacts import (
    build_download_name,
    fallback_display_name,
    format_size,
    is_valid_contacts_filename,
    list_saved_contacts_files,
    load_contacts_metadata,
    parse_contacts_rows,
    read_contacts_preview,
    read_contacts_table,
    remove_contacts_metadata,
    resolve_saved_contacts_path,
    sanitize_metadata_text,
    save_contacts_content,
    save_contacts_upload,
    set_contacts_metadata,
)
from .errors import AppError, handle_api_exception, json_error
from .messaging import normalize_to_whatsapp_id, render_message_template, upload_to_data_url
from .node_api import NodeApiClient


def _empty_preview_payload() -> dict:
    return {
        "headers": [],
        "rows": [],
        "total_rows": 0,
        "displayed_rows": 0,
        "truncated": False,
        "total_columns": 0,
        "displayed_columns": 0,
    }


def register_routes(app, node_api: NodeApiClient) -> None:
    @app.get("/")
    def home():
        uploaded_excel_files = list_saved_contacts_files()
        selected_existing_contacts_file = ""
        requested_file = request.args.get("existing_contacts_file", "").strip()
        if requested_file:
            try:
                selected_existing_contacts_file = resolve_saved_contacts_path(requested_file).name
            except AppError:
                selected_existing_contacts_file = ""

        return render_template(
            "index.html",
            default_country_code=DEFAULT_COUNTRY_CODE,
            default_message_template=load_default_message_template(),
            uploaded_excel_files=uploaded_excel_files,
            selected_existing_contacts_file=selected_existing_contacts_file,
        )

    @app.post("/api/auth/start")
    def api_auth_start():
        try:
            data = node_api.call_api("POST", "/auth/start", payload={}, timeout=10)
            if not data.get("ok"):
                raise AppError(
                    code="AUTH_START_FAILED",
                    message="Failed to start WhatsApp login.",
                    status=502,
                    details=data.get("error"),
                )
            return jsonify(data)
        except Exception as exc:
            return handle_api_exception(exc)

    @app.get("/api/auth/status")
    def api_auth_status():
        try:
            data = node_api.call_api("GET", "/auth/status", timeout=10)
            if not data.get("ok"):
                raise AppError(
                    code="AUTH_STATUS_FAILED",
                    message="Failed to read WhatsApp login status.",
                    status=502,
                    details=data.get("error"),
                )
            return jsonify(data)
        except Exception as exc:
            return handle_api_exception(exc)

    @app.get("/api/contacts/history")
    def api_contacts_history():
        try:
            return jsonify({"ok": True, "files": list_saved_contacts_files()})
        except Exception as exc:
            return handle_api_exception(exc)

    @app.post("/api/contacts/upload")
    def api_contacts_upload():
        contacts_file = request.files.get("contacts_file")

        try:
            if not contacts_file or not (contacts_file.filename or "").strip():
                raise AppError(
                    code="CONTACTS_UPLOAD_MISSING",
                    message="Choose a contacts file to upload.",
                    status=400,
                )

            contacts_filename = (contacts_file.filename or "").strip()
            if not is_valid_contacts_filename(contacts_filename):
                raise AppError(
                    code="INVALID_CONTACTS_FILE",
                    message="Upload a valid contacts file (.xlsx or .csv).",
                    status=400,
                )

            contacts_bytes = contacts_file.read()
            if not contacts_bytes:
                raise AppError(
                    code="EXCEL_EMPTY",
                    message="Contacts file is empty.",
                    status=400,
                )

            read_contacts_table(
                filename=contacts_filename,
                content=contacts_bytes,
                error_code="EXCEL_PARSE_ERROR",
                error_message="Could not read the contacts file. Please check the file format.",
            )

            stored_name = save_contacts_upload(contacts_filename, contacts_bytes)
            file_info = next(
                (item for item in list_saved_contacts_files() if item.get("name") == stored_name),
                None,
            )

            return jsonify(
                {
                    "ok": True,
                    "message": "Contacts file uploaded and saved.",
                    "file": file_info
                    or {
                        "name": stored_name,
                        "display_name": Path(contacts_filename).name,
                        "description": "",
                        "modified_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                        "size_bytes": len(contacts_bytes),
                        "size_label": format_size(len(contacts_bytes)),
                    },
                }
            )
        except Exception as exc:
            return handle_api_exception(exc)

    @app.get("/api/contacts/<path:file_name>/preview")
    def api_contacts_preview(file_name: str):
        try:
            file_path = resolve_saved_contacts_path(file_name)
            metadata = load_contacts_metadata().get(file_path.name, {})
            preview = read_contacts_preview(file_path)
            return jsonify(
                {
                    "ok": True,
                    "file": {
                        "name": file_path.name,
                        "display_name": metadata.get("display_name") or fallback_display_name(file_path.name),
                        "description": metadata.get("description", ""),
                    },
                    "preview": preview,
                }
            )
        except Exception as exc:
            return handle_api_exception(exc)

    @app.post("/api/contacts/<path:file_name>/content")
    def api_contacts_content(file_name: str):
        try:
            file_path = resolve_saved_contacts_path(file_name)
            payload = request.get_json(silent=True) or {}
            if not isinstance(payload, dict):
                payload = {}

            headers = payload.get("headers", [])
            rows = payload.get("rows", [])
            summary = save_contacts_content(file_path=file_path, headers=headers, rows=rows)
            preview = read_contacts_preview(file_path, row_limit=None, column_limit=None)
            return jsonify({"ok": True, "summary": summary, "preview": preview})
        except Exception as exc:
            return handle_api_exception(exc)

    @app.post("/api/contacts/<path:file_name>/metadata")
    def api_contacts_metadata(file_name: str):
        try:
            _ = resolve_saved_contacts_path(file_name)
            payload = request.get_json(silent=True) or {}
            if not isinstance(payload, dict):
                payload = {}

            display_name = sanitize_metadata_text(payload.get("display_name"), max_len=120)
            description = sanitize_metadata_text(payload.get("description"), max_len=500)
            if not display_name:
                raise AppError(
                    code="INVALID_CONTACT_METADATA",
                    message="Contacts file name cannot be empty.",
                    status=400,
                )

            set_contacts_metadata(file_name, display_name=display_name, description=description)
            return jsonify({"ok": True})
        except Exception as exc:
            return handle_api_exception(exc)

    @app.get("/api/contacts/<path:file_name>/download")
    def api_contacts_download(file_name: str):
        try:
            file_path = resolve_saved_contacts_path(file_name)
            metadata = load_contacts_metadata().get(file_path.name, {})
            display_name = metadata.get("display_name") or fallback_display_name(file_path.name)
            download_name = build_download_name(file_path, display_name)
            return send_file(
                file_path,
                as_attachment=True,
                download_name=download_name,
                mimetype=mimetypes.guess_type(str(file_path))[0] or "application/octet-stream",
            )
        except Exception as exc:
            return handle_api_exception(exc)

    @app.delete("/api/contacts/<path:file_name>")
    def api_contacts_delete(file_name: str):
        try:
            file_path = resolve_saved_contacts_path(file_name)
            try:
                file_path.unlink()
            except OSError as exc:
                raise AppError(
                    code="CONTACTS_DELETE_FAILED",
                    message="Could not delete contacts file.",
                    status=500,
                    details=str(exc),
                ) from exc

            remove_contacts_metadata(file_path.name)
            return jsonify({"ok": True, "message": "Contacts file deleted."})
        except Exception as exc:
            return handle_api_exception(exc)

    @app.get("/contacts/<path:file_name>")
    def contacts_details_page(file_name: str):
        try:
            file_path = resolve_saved_contacts_path(file_name)
            file_info = next(
                (item for item in list_saved_contacts_files() if item.get("name") == file_path.name),
                None,
            )
            if not file_info:
                raise AppError(
                    code="CONTACT_FILE_NOT_FOUND",
                    message="Selected contacts file was not found.",
                    status=404,
                )

            preview = read_contacts_preview(file_path, row_limit=None, column_limit=None)
            return render_template(
                "contact_details.html",
                contact_file=file_info,
                preview=preview,
                load_error="",
            )
        except AppError as exc:
            return (
                render_template(
                    "contact_details.html",
                    contact_file=None,
                    preview=_empty_preview_payload(),
                    load_error=exc.message,
                ),
                exc.status,
            )
        except Exception:
            return (
                render_template(
                    "contact_details.html",
                    contact_file=None,
                    preview=_empty_preview_payload(),
                    load_error="Could not load this contacts file.",
                ),
                500,
            )

    @app.post("/api/send")
    def api_send():
        phone = request.form.get("phone", "").strip()
        message = request.form.get("message", "").strip()
        uploaded_file = request.files.get("media")
        contacts_file = request.files.get("contacts_file")
        existing_contacts_file = request.form.get("existing_contacts_file", "").strip()

        try:
            has_contacts_file = bool(contacts_file and contacts_file.filename)
            has_existing_contacts_file = bool(existing_contacts_file)
            has_media = bool(uploaded_file and uploaded_file.filename)
            has_message = bool(message)

            if not has_contacts_file and not has_existing_contacts_file and not phone:
                raise AppError(
                    code="MISSING_TARGET",
                    message="Enter a phone number, upload a contacts file, or select an existing contacts file.",
                    status=400,
                )

            if not has_message and not has_media:
                raise AppError(
                    code="MISSING_CONTENT",
                    message="Write a message or choose a media file.",
                    status=400,
                )

            if has_contacts_file or has_existing_contacts_file:
                contacts_filename = ""
                contacts_bytes = b""

                if has_contacts_file:
                    contacts_filename = (contacts_file.filename or "").strip()
                    if not contacts_filename:
                        raise AppError(
                            code="INVALID_CONTACTS_FILE",
                            message="Upload a valid contacts file (.xlsx or .csv).",
                            status=400,
                        )

                    if not is_valid_contacts_filename(contacts_filename):
                        raise AppError(
                            code="INVALID_CONTACTS_FILE",
                            message="Upload a valid contacts file (.xlsx or .csv).",
                            status=400,
                        )

                    contacts_bytes = contacts_file.read()
                    if not contacts_bytes:
                        raise AppError(
                            code="EXCEL_EMPTY",
                            message="Contacts file is empty.",
                            status=400,
                        )

                    save_contacts_upload(contacts_filename, contacts_bytes)
                else:
                    existing_path = resolve_saved_contacts_path(existing_contacts_file)
                    contacts_filename = existing_path.name
                    try:
                        contacts_bytes = existing_path.read_bytes()
                    except OSError as exc:
                        raise AppError(
                            code="CONTACTS_PREVIEW_FAILED",
                            message="Could not read the selected contacts file.",
                            status=400,
                            details=str(exc),
                        ) from exc

                    if not contacts_bytes:
                        raise AppError(
                            code="EXCEL_EMPTY",
                            message="Contacts file is empty.",
                            status=400,
                        )

                rows = parse_contacts_rows(contacts_filename, contacts_bytes)
                media_data_url = upload_to_data_url(uploaded_file) if has_media else ""
                media_filename = uploaded_file.filename if has_media else ""

                try:
                    for index, row in enumerate(rows):
                        row_number = row.get("NUMBERS", "")
                        to = normalize_to_whatsapp_id(row_number)
                        rendered_message = render_message_template(message, row).strip()
                        keep_session = True

                        if has_media:
                            node_api.send_media(
                                to=to,
                                filename=media_filename,
                                caption=rendered_message,
                                data_url=media_data_url,
                                keep_session=keep_session,
                            )
                        else:
                            if not rendered_message:
                                raise AppError(
                                    code="EMPTY_ROW_MESSAGE",
                                    message="Message is empty for one or more rows after variable replacement.",
                                    status=400,
                                    details=f"Row {row.get('__row_index', '?')}",
                                )
                            node_api.send_text(to=to, message=rendered_message, keep_session=keep_session)

                        if index < len(rows) - 1 and BATCH_SEND_DELAY_SECONDS > 0:
                            time.sleep(BATCH_SEND_DELAY_SECONDS)
                except AppError:
                    try:
                        node_api.logout_session()
                    except Exception:
                        pass
                    raise
                except Exception as exc:
                    try:
                        node_api.logout_session()
                    except Exception:
                        pass
                    raise AppError(
                        code="BATCH_ROW_FAILED",
                        message="Failed while sending one of the contacts rows.",
                        status=502,
                        details=str(exc),
                    ) from exc

                logout_warning = None
                try:
                    node_api.logout_session()
                except Exception as exc:
                    logout_warning = str(exc)

                result_message = (
                    f"Batch sent successfully to {len(rows)} row(s). "
                    "You are logged out; a new QR code will be required next send."
                )
                if logout_warning:
                    result_message = (
                        f"Batch sent successfully to {len(rows)} row(s), but automatic logout failed. "
                        "Restart the app before the next batch."
                    )

                return jsonify(
                    {
                        "ok": True,
                        "message": result_message,
                    }
                )

            to = normalize_to_whatsapp_id(phone)

            if has_media:
                data_url = upload_to_data_url(uploaded_file)
                node_api.send_media(
                    to=to,
                    filename=uploaded_file.filename,
                    caption=message,
                    data_url=data_url,
                    keep_session=False,
                )
                return jsonify(
                    {
                        "ok": True,
                        "message": f"Media sent to {to}. You are logged out; a new QR code will be required next send.",
                    }
                )

            node_api.send_text(to=to, message=message, keep_session=False)
            return jsonify(
                {
                    "ok": True,
                    "message": f"Text sent to {to}. You are logged out; a new QR code will be required next send.",
                }
            )
        except ValueError as exc:
            return json_error(
                code="VALIDATION_ERROR",
                message=str(exc),
                status=400,
            )
        except Exception as exc:
            return handle_api_exception(exc)

    @app.errorhandler(413)
    def handle_payload_too_large(_exc):
        return json_error(
            code="MEDIA_TOO_LARGE",
            message="Selected media is too large. Choose a smaller file and try again.",
            status=413,
        )

