"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BILL_UNITS = exports.MAX_BILL_MILES = void 0;
exports.billingLimitIssues = billingLimitIssues;
exports.assertBillingLimits = assertBillingLimits;
/** Company policy: limits apply to the whole bill, including all return legs. */
exports.MAX_BILL_MILES = 50;
exports.MAX_BILL_UNITS = 2;
function billingLimitIssues(record) {
    const issues = [];
    const present = (v) => v !== undefined && v !== null && v !== '';
    const check = (values, max, label) => {
        if (values.filter(present).some(v => !Number.isFinite(Number(v)) || Number(v) < 0 || Number(v) > max))
            issues.push(`Billing blocked: ${label} must not exceed ${max} per bill. Review the original trip; do not split or reduce it automatically.`);
    };
    check([record.miles, record.billed_miles, record.mileage_units, record.total_miles], exports.MAX_BILL_MILES, 'total miles');
    check([record.trip_units, record.units, record.trip_unit_count, record.base_units], exports.MAX_BILL_UNITS, 'trip units');
    const legs = record.odometer_legs ?? record.legs ?? record.trip_legs ?? record.corrected_legs;
    if (Array.isArray(legs) && legs.length) {
        check([legs.length], exports.MAX_BILL_UNITS, 'trip units');
        check([legs.reduce((sum, l) => sum + Number(l.dropoff_odometer) - Number(l.pickup_odometer), 0)], exports.MAX_BILL_MILES, 'total miles');
    }
    for (const lines of [record.service_lines, record.claim_service_lines, record.corrected_service_lines, record.resubmission_service_lines]) {
        if (!Array.isArray(lines))
            continue;
        const isMileage = (l) => /mile/i.test(String(l.unit_type ?? l.unit_word ?? '')) || /^(S0215|A0425)$/i.test(String(l.procedure_code ?? l.code ?? ''));
        check([lines.filter(isMileage).reduce((s, l) => s + Number(l.units ?? l.miles ?? 0), 0)], exports.MAX_BILL_MILES, 'total miles');
        check([lines.filter((l) => !isMileage(l)).reduce((s, l) => s + Number(l.units ?? 0), 0)], exports.MAX_BILL_UNITS, 'trip units');
    }
    return [...new Set(issues)];
}
function assertBillingLimits(record) {
    const issue = billingLimitIssues(record)[0];
    if (issue)
        throw new Error(issue);
}
