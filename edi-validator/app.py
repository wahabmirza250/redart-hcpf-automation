from __future__ import annotations

import hmac
import os
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from colorado837p import validate_colorado_837p
from pyx12_validator import validate_with_pyx12

app = FastAPI(
    title="RedArt Colorado EDI Validator",
    version="0.1.0",
    description="Preflight validation for Colorado Medicaid 837P 005010X222A1.",
)


class Validate837PRequest(BaseModel):
    x12: str = Field(min_length=106, max_length=10_000_000)
    tpid: str = Field(min_length=1, max_length=15)
    usage: Literal["T", "P"] = "T"


def require_service_token(
    x_service_token: Annotated[str | None, Header()] = None,
) -> None:
    expected = os.getenv("EDI_VALIDATOR_TOKEN", "").strip()
    allow_insecure_local = os.getenv("EDI_VALIDATOR_ALLOW_INSECURE_LOCAL", "").strip() == "1"

    if not expected:
        if allow_insecure_local:
            return
        raise HTTPException(
            status_code=503,
            detail="EDI validator service token is not configured",
        )

    supplied = (x_service_token or "").strip()
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Invalid service token")


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "validator": "pyx12-4.0.0",
        "transaction": "837P-005010X222A1",
        "state": "Colorado",
    }


@app.post("/v1/colorado/837p/validate", dependencies=[Depends(require_service_token)])
def validate_837p(payload: Validate837PRequest) -> dict:
    pyx12_result = validate_with_pyx12(payload.x12)
    colorado_errors, metadata = validate_colorado_837p(
        payload.x12,
        expected_tpid=payload.tpid,
        expected_usage=payload.usage,
    )

    colorado_valid = len(colorado_errors) == 0
    ready_for_sftp = bool(pyx12_result["valid"] and colorado_valid)

    return {
        "ready_for_sftp": ready_for_sftp,
        "pyx12": {
            "version": "4.0.0",
            "valid": pyx12_result["valid"],
            "errors": pyx12_result["errors"],
            "local_999": pyx12_result["local_999"],
            "local_999_is_state_acknowledgment": False,
        },
        "colorado": {
            "valid": colorado_valid,
            "errors": colorado_errors,
            "metadata": metadata,
        },
        "submission_rule": (
            "Send to HCPF SFTP only when ready_for_sftp=true. After sending, "
            "wait for the real HCPF TA1/999/277CA and correlate it using the "
            "ISA/GS/ST control numbers. Never treat the local pyx12 999 as "
            "proof that Colorado received the claim."
        ),
    }
