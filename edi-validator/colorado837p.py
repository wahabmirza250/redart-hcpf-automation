from __future__ import annotations

from dataclasses import dataclass
from typing import Any

COLORADO_RECEIVER_ID = "COMEDASSISTPROG"
COLORADO_RECEIVER_NAME = "COLORADO MEDICAL ASSISTANCE PROGRAM"
COLORADO_PAYER_ID = "CO_TXIX"
IMPLEMENTATION_VERSION = "005010X222A1"


@dataclass(frozen=True)
class ParsedX12:
    element_separator: str
    component_separator: str
    segment_terminator: str
    segments: list[list[str]]


def _clean_x12(raw: str) -> str:
    return raw.lstrip("\ufeff\r\n\t ")


def parse_x12(raw: str) -> ParsedX12:
    text = _clean_x12(raw)
    if not text.startswith("ISA"):
        raise ValueError("X12 document must begin with ISA")
    if len(text) < 4:
        raise ValueError("X12 document is too short")

    element_separator = text[3]

    # A valid ISA is fixed width: ISA16 is at position 104 and the segment
    # terminator is position 105 (zero-based). Fall back to common delimiters
    # only so we can return a useful validation error for malformed envelopes.
    component_separator = text[104] if len(text) > 104 else ":"
    segment_terminator = text[105] if len(text) > 105 else "~"
    if segment_terminator.isalnum() or segment_terminator in {" ", "\r", "\n", "\t"}:
        segment_terminator = "~" if "~" in text else "\n"

    raw_segments = text.split(segment_terminator)
    segments: list[list[str]] = []
    for raw_segment in raw_segments:
        segment = raw_segment.strip("\r\n\t ")
        if not segment:
            continue
        segments.append(segment.split(element_separator))

    return ParsedX12(
        element_separator=element_separator,
        component_separator=component_separator,
        segment_terminator=segment_terminator,
        segments=segments,
    )


def _first(parsed: ParsedX12, tag: str) -> list[str] | None:
    return next((seg for seg in parsed.segments if seg and seg[0] == tag), None)


def _all(parsed: ParsedX12, tag: str) -> list[list[str]]:
    return [seg for seg in parsed.segments if seg and seg[0] == tag]


def _nm1(parsed: ParsedX12, entity_code: str) -> list[list[str]]:
    return [
        seg
        for seg in parsed.segments
        if len(seg) > 1 and seg[0] == "NM1" and seg[1] == entity_code
    ]


def _value(segment: list[str] | None, index: int) -> str:
    if not segment or len(segment) <= index:
        return ""
    return segment[index]


def _error(
    code: str,
    segment: str,
    field: str,
    message: str,
    expected: str | None = None,
    actual: str | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "code": code,
        "segment": segment,
        "field": field,
        "message": message,
    }
    if expected is not None:
        item["expected"] = expected
    if actual is not None:
        item["actual"] = actual
    return item


def validate_colorado_837p(
    raw: str,
    *,
    expected_tpid: str | None = None,
    expected_usage: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Validate Colorado Medicaid companion-guide rules layered on 837P X222A1.

    pyx12 remains responsible for HIPAA/TR3 validation. This function checks
    Colorado-specific routing and companion-guide constraints that a generic
    X12 validator cannot know.
    """

    errors: list[dict[str, Any]] = []
    try:
        parsed = parse_x12(raw)
    except ValueError as exc:
        return [
            _error(
                "CO-X12-ENVELOPE",
                "ISA",
                "envelope",
                str(exc),
            )
        ], {}

    isa = _first(parsed, "ISA")
    gs = _first(parsed, "GS")
    st = _first(parsed, "ST")
    bht = _first(parsed, "BHT")

    isa_count = len(_all(parsed, "ISA"))
    if isa_count != 1:
        errors.append(
            _error(
                "CO-ISA-COUNT",
                "ISA",
                "ISA",
                "Colorado inbound files must contain one ISA interchange.",
                "1",
                str(isa_count),
            )
        )

    if not isa:
        errors.append(_error("CO-ISA-MISSING", "ISA", "ISA", "ISA segment is required."))
    else:
        checks = [
            (5, "ISA05", "ZZ", "CO-ISA05"),
            (7, "ISA07", "ZZ", "CO-ISA07"),
            (8, "ISA08", COLORADO_RECEIVER_ID, "CO-ISA08"),
            (12, "ISA12", "00501", "CO-ISA12"),
        ]
        for index, field, expected, code in checks:
            actual = _value(isa, index).strip()
            if actual != expected:
                errors.append(
                    _error(
                        code,
                        "ISA",
                        field,
                        f"{field} does not match the Colorado Medicaid requirement.",
                        expected,
                        actual,
                    )
                )

        sender_tpid = _value(isa, 6).strip()
        if not sender_tpid:
            errors.append(
                _error(
                    "CO-ISA06-MISSING",
                    "ISA",
                    "ISA06",
                    "ISA06 must contain the Colorado-assigned Trading Partner ID.",
                )
            )
        elif expected_tpid and sender_tpid != expected_tpid.strip():
            errors.append(
                _error(
                    "CO-ISA06-TPID",
                    "ISA",
                    "ISA06",
                    "ISA06 does not match the TPID supplied by the calling company configuration.",
                    expected_tpid.strip(),
                    sender_tpid,
                )
            )

        usage = _value(isa, 15).strip()
        if usage not in {"T", "P"}:
            errors.append(
                _error(
                    "CO-ISA15",
                    "ISA",
                    "ISA15",
                    "ISA15 must be T for test or P for production.",
                    "T or P",
                    usage,
                )
            )
        elif expected_usage and usage != expected_usage:
            errors.append(
                _error(
                    "CO-ISA15-MODE",
                    "ISA",
                    "ISA15",
                    "ISA15 does not match the requested submission mode.",
                    expected_usage,
                    usage,
                )
            )

    if not gs:
        errors.append(_error("CO-GS-MISSING", "GS", "GS", "GS segment is required."))
    else:
        gs_checks = [
            (1, "GS01", "HC", "CO-GS01"),
            (3, "GS03", COLORADO_RECEIVER_ID, "CO-GS03"),
            (8, "GS08", IMPLEMENTATION_VERSION, "CO-GS08"),
        ]
        for index, field, expected, code in gs_checks:
            actual = _value(gs, index).strip()
            if actual != expected:
                errors.append(
                    _error(
                        code,
                        "GS",
                        field,
                        f"{field} does not match the Colorado Medicaid requirement.",
                        expected,
                        actual,
                    )
                )

        gs_sender = _value(gs, 2).strip()
        isa_sender = _value(isa, 6).strip()
        expected_sender = expected_tpid.strip() if expected_tpid else isa_sender
        if not gs_sender or (expected_sender and gs_sender != expected_sender):
            errors.append(
                _error(
                    "CO-GS02-TPID",
                    "GS",
                    "GS02",
                    "GS02 must contain the same Colorado-assigned TPID used for the sender.",
                    expected_sender or "Colorado-assigned TPID",
                    gs_sender,
                )
            )

    if not st:
        errors.append(_error("CO-ST-MISSING", "ST", "ST", "ST segment is required."))
    else:
        if _value(st, 1).strip() != "837":
            errors.append(
                _error("CO-ST01", "ST", "ST01", "Transaction must be an 837 claim.", "837", _value(st, 1).strip())
            )
        if _value(st, 3).strip() != IMPLEMENTATION_VERSION:
            errors.append(
                _error(
                    "CO-ST03",
                    "ST",
                    "ST03",
                    "Colorado professional claims must use 005010X222A1.",
                    IMPLEMENTATION_VERSION,
                    _value(st, 3).strip(),
                )
            )

    if not bht:
        errors.append(_error("CO-BHT-MISSING", "BHT", "BHT", "BHT segment is required."))
    else:
        bht06 = _value(bht, 6).strip()
        if bht06 not in {"CH", "RP"}:
            errors.append(
                _error(
                    "CO-BHT06",
                    "BHT",
                    "BHT06",
                    "Colorado accepts CH for fee-for-service or RP for encounter claims.",
                    "CH or RP",
                    bht06,
                )
            )

    receivers = _nm1(parsed, "40")
    if not receivers:
        errors.append(
            _error("CO-1000B-MISSING", "NM1", "1000B", "Receiver NM1*40 segment is required.")
        )
    else:
        receiver = receivers[0]
        if _value(receiver, 3).strip() != COLORADO_RECEIVER_NAME:
            errors.append(
                _error(
                    "CO-1000B-NM103",
                    "NM1",
                    "NM103",
                    "Receiver name does not match Colorado Medicaid.",
                    COLORADO_RECEIVER_NAME,
                    _value(receiver, 3).strip(),
                )
            )
        if _value(receiver, 9).strip() != COLORADO_RECEIVER_ID:
            errors.append(
                _error(
                    "CO-1000B-NM109",
                    "NM1",
                    "NM109",
                    "Receiver primary identifier does not match Colorado Medicaid.",
                    COLORADO_RECEIVER_ID,
                    _value(receiver, 9).strip(),
                )
            )

    subscribers = _nm1(parsed, "IL")
    if not subscribers:
        errors.append(
            _error("CO-2010BA-MISSING", "NM1", "2010BA", "Subscriber NM1*IL segment is required.")
        )
    for subscriber in subscribers:
        qualifier = _value(subscriber, 8).strip()
        member_id = _value(subscriber, 9).strip()
        if qualifier != "MI":
            errors.append(
                _error(
                    "CO-2010BA-NM108",
                    "NM1",
                    "NM108",
                    "Colorado subscriber identification qualifier must be MI.",
                    "MI",
                    qualifier,
                )
            )
        if not member_id:
            errors.append(
                _error(
                    "CO-2010BA-NM109",
                    "NM1",
                    "NM109",
                    "Colorado Medical Assistance Program Client ID is required.",
                )
            )

    payers = _nm1(parsed, "PR")
    if not payers:
        errors.append(
            _error("CO-2010BB-MISSING", "NM1", "2010BB", "Payer NM1*PR segment is required.")
        )
    for payer in payers:
        qualifier = _value(payer, 8).strip()
        payer_id = _value(payer, 9).strip()
        if qualifier != "PI":
            errors.append(
                _error(
                    "CO-2010BB-NM108",
                    "NM1",
                    "NM108",
                    "Colorado payer identification qualifier must be PI.",
                    "PI",
                    qualifier,
                )
            )
        if payer_id != COLORADO_PAYER_ID:
            errors.append(
                _error(
                    "CO-2010BB-NM109",
                    "NM1",
                    "NM109",
                    "Colorado Medicaid payer identifier must be CO_TXIX.",
                    COLORADO_PAYER_ID,
                    payer_id,
                )
            )

    for sbr in _all(parsed, "SBR"):
        filing_code = _value(sbr, 9).strip()
        if filing_code not in {"MC", "16", "MA", "MB"}:
            errors.append(
                _error(
                    "CO-SBR09",
                    "SBR",
                    "SBR09",
                    "Use MC for standard Medicaid claims; Colorado also allows 16, MA, or MB for Medicare crossovers.",
                    "MC, 16, MA, or MB",
                    filing_code,
                )
            )

    if _all(parsed, "PWK"):
        errors.append(
            _error(
                "CO-PWK-UNSUPPORTED",
                "PWK",
                "PWK",
                "Colorado Medicaid's current 837P companion guide does not support PWK on this transaction.",
            )
        )

    # Colorado only recognizes claim frequency codes 1, 7, and 8. For an
    # adjustment/void (7/8), the claim loop must carry the payer claim control
    # number. We check within the segment range for the current CLM.
    clm_positions = [i for i, seg in enumerate(parsed.segments) if seg and seg[0] == "CLM"]
    for position_index, position in enumerate(clm_positions):
        clm = parsed.segments[position]
        clm05 = _value(clm, 5)
        components = clm05.split(parsed.component_separator) if clm05 else []
        frequency = components[2].strip() if len(components) > 2 else ""
        if frequency not in {"1", "7", "8"}:
            errors.append(
                _error(
                    "CO-CLM05-3",
                    "CLM",
                    "CLM05-3",
                    "Colorado recognizes claim frequency codes 1, 7, and 8.",
                    "1, 7, or 8",
                    frequency,
                )
            )
            continue

        if frequency in {"7", "8"}:
            next_position = (
                clm_positions[position_index + 1]
                if position_index + 1 < len(clm_positions)
                else len(parsed.segments)
            )
            claim_segments = parsed.segments[position + 1 : next_position]
            has_payer_control = any(
                len(seg) > 2 and seg[0] == "REF" and seg[1] == "F8" and bool(seg[2].strip())
                for seg in claim_segments
            )
            if not has_payer_control:
                errors.append(
                    _error(
                        "CO-CLM-ADJUSTMENT-REF",
                        "REF",
                        "REF*F8",
                        "Frequency 7 or 8 requires the payer claim control number/Colorado ICN in the claim loop.",
                    )
                )

    metadata = {
        "implementation_version": _value(gs, 8).strip() or _value(st, 3).strip(),
        "sender_tpid": _value(isa, 6).strip(),
        "receiver_id": _value(isa, 8).strip(),
        "usage": _value(isa, 15).strip(),
        "claim_count": len(clm_positions),
        "subscriber_count": len(subscribers),
    }
    return errors, metadata
