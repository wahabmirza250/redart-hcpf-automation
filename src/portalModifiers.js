'use strict';

function modifierLabelPattern(code) {
  const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}(?:\\s*[-–—:]\\s*.*|\\s+[^\\d].*)?\\s*$`, 'i');
}

// Enter these last: subsequent service-field postbacks can replace the editor.
// The saved service-line check remains the authority before Submit is allowed.
async function fillPortalModifiers({ page, current, selectors, modifiers, procedureCode }) {
  const expected = Array.isArray(modifiers) ? modifiers.filter(Boolean).map(v => String(v).trim().toUpperCase()) : [];
  if (expected.length > 4) throw new Error(`BLOCKED_TOO_MANY_MODIFIERS: ${procedureCode} has ${expected.length}; HCPF supports at most 4.`);
  for (let index = 0; index < expected.length; index++) {
    const code = expected[index];
    const selector = selectors[index];
    if (!selector) throw new Error(`BLOCKED_MODIFIER_FIELD_UNAVAILABLE: no configured HCPF modifier ${index + 1} field for ${procedureCode}.`);
    const field = current(selector);
    if (await field.count() === 0 || !await field.isVisible()) throw new Error(`BLOCKED_MODIFIER_FIELD_UNAVAILABLE: HCPF modifier ${index + 1} field is missing for ${procedureCode}.`);
    const pattern = modifierLabelPattern(code);
    const tag = await field.evaluate(el => el.tagName.toLowerCase());
    if (tag === 'select') {
      const options = await field.locator('option').evaluateAll(items => items.map(o => ({ value: o.value, label: o.textContent || '' })));
      const option = options.find(o => pattern.test(o.label)) || options.find(o => o.value === code);
      if (!option) throw new Error(`BLOCKED_MODIFIER_NOT_ACCEPTED: HCPF has no option for modifier ${code}.`);
      await field.selectOption({ value: option.value }, { timeout: 8000 });
    } else {
      await field.fill('', { timeout: 8000 });
      await field.pressSequentially(code, { delay: 80 });
      let suggestion;
      for (let poll = 0; poll < 12 && !suggestion; poll++) {
        for (const candidate of await page.getByText(pattern).all()) {
          if (await candidate.isVisible()) { suggestion = candidate; break; }
        }
        if (!suggestion) await page.waitForTimeout(250);
      }
      if (suggestion) {
        // Do not swallow a failed selection and mistake typed text for acceptance.
        await suggestion.click({ timeout: 5000 });
      }
      await current(selector).blur();
    }
  }
  // Re-read every modifier after all selections: a later field may post back.
  for (let index = 0; index < expected.length; index++) {
    const field = current(selectors[index]);
    const tag = await field.evaluate(el => el.tagName.toLowerCase());
    const actual = tag === 'select'
      ? await field.evaluate(el => el.selectedOptions[0]?.textContent || '')
      : await field.inputValue({ timeout: 5000 });
    if (!modifierLabelPattern(expected[index]).test(String(actual))) {
      throw new Error(`BLOCKED_MODIFIER_NOT_ACCEPTED: expected modifier ${expected[index]} for ${procedureCode}, but HCPF field shows "${actual || 'blank'}".`);
    }
  }
  return expected;
}

module.exports = { modifierLabelPattern, fillPortalModifiers };
