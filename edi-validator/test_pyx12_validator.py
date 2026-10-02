from pyx12_validator import validate_with_pyx12
from test_colorado837p import _sample_x12


def test_pyx12_5010_path_runs_and_emits_local_acknowledgment() -> None:
    result = validate_with_pyx12(_sample_x12())
    assert "validator_exception" not in (result["errors"] or {})
    assert result["local_999"]
    assert "ST*999*" in result["local_999"]
