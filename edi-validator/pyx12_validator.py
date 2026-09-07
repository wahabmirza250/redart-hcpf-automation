from __future__ import annotations

import io
import json
from typing import Any

import pyx12.params
import pyx12.x12n_document


def validate_with_pyx12(raw_x12: str) -> dict[str, Any]:
    """Run the pyx12 5010 validator and return its local 999 + JSON errors.

    IMPORTANT: The returned acknowledgment is generated locally by pyx12.
    It is a preflight artifact only and must never be recorded as an HCPF
    acknowledgment. A real HCPF 999/TA1/277CA must come back through the
    Colorado trading-partner transport after submission.
    """

    ack_stream = io.StringIO()
    json_stream = io.StringIO()
    source_stream = io.StringIO(raw_x12.lstrip("\ufeff\r\n\t "))
    param = pyx12.params.params()

    try:
        valid = pyx12.x12n_document.x12n_document(
            param=param,
            src_file=source_stream,
            fd_997=ack_stream,
            fd_html=None,
            fd_xmldoc=None,
            fd_json=json_stream,
            xslt_files=None,
        )
    except Exception as exc:  # pyx12 exposes several parser/map exceptions
        return {
            "valid": False,
            "local_999": ack_stream.getvalue() or None,
            "errors": {
                "validator_exception": {
                    "type": type(exc).__name__,
                    "message": str(exc),
                }
            },
        }

    structured_errors: Any = None
    raw_json = json_stream.getvalue().strip()
    if raw_json:
        try:
            structured_errors = json.loads(raw_json)
        except json.JSONDecodeError:
            structured_errors = {"raw": raw_json}

    return {
        "valid": bool(valid),
        "local_999": ack_stream.getvalue() or None,
        "errors": structured_errors,
    }
