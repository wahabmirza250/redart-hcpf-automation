from colorado837p import validate_colorado_837p


def _sample_x12(tpid: str = "12345678", usage: str = "T", extra_claim_segment: str = "") -> str:
    isa = (
        f"ISA*00*          *00*          *ZZ*{tpid:<15}*ZZ*COMEDASSISTPROG*"
        f"260907*1200*^*00501*000000001*0*{usage}*:~"
    )
    assert len(isa) == 106
    return (
        isa
        + f"GS*HC*{tpid}*COMEDASSISTPROG*20260907*1200*1*X*005010X222A1~"
        + "ST*837*0001*005010X222A1~"
        + "BHT*0019*00*0001*20260907*1200*CH~"
        + "NM1*40*2*COLORADO MEDICAL ASSISTANCE PROGRAM*****46*COMEDASSISTPROG~"
        + "SBR*P*18*******MC~"
        + "NM1*IL*1*DOE*JANE****MI*123456789~"
        + "NM1*PR*2*COLORADO MEDICAL ASSISTANCE PROGRAM*****PI*CO_TXIX~"
        + "CLM*TESTCLAIM*10***11:B:1*Y*A*Y*I~"
        + extra_claim_segment
        + "SE*9*0001~GE*1*1~IEA*1*000000001~"
    )


def test_colorado_rules_accept_expected_routing() -> None:
    errors, metadata = validate_colorado_837p(
        _sample_x12(), expected_tpid="12345678", expected_usage="T"
    )
    assert errors == []
    assert metadata["sender_tpid"] == "12345678"
    assert metadata["receiver_id"] == "COMEDASSISTPROG"
    assert metadata["claim_count"] == 1


def test_tpid_is_dynamic_and_must_match_company_configuration() -> None:
    errors, _ = validate_colorado_837p(
        _sample_x12(tpid="12345678"), expected_tpid="87654321", expected_usage="T"
    )
    codes = {error["code"] for error in errors}
    assert "CO-ISA06-TPID" in codes
    assert "CO-GS02-TPID" in codes


def test_colorado_rejects_pwk() -> None:
    errors, _ = validate_colorado_837p(
        _sample_x12(extra_claim_segment="PWK*OZ*EL~"),
        expected_tpid="12345678",
        expected_usage="T",
    )
    assert "CO-PWK-UNSUPPORTED" in {error["code"] for error in errors}
