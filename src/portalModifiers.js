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

async function verifySavedPortalModifiers({ page, current, selectors, rowNumber, procedureCode, modifiers }) {
  // HCPF's summary grid omits modifiers entirely. Reopen the numbered SAVED
  // row, then read its editor without typing or clicking Add/Update again.
  async function openRow(number, expectedProcedure) {
    const id = await page.evaluate(({ number, expectedProcedure }) => {
      const matches = Array.from(document.querySelectorAll('tr')).filter(row => {
        const cells = Array.from(row.cells);
        if (cells.length < 6 || (cells[0].textContent || '').trim() !== String(number)) return false;
        if (expectedProcedure && !cells.some(cell => (cell.textContent || '').trim().toUpperCase().startsWith(expectedProcedure + '-'))) return false;
        return true;
      });
      if (matches.length !== 1) return null;
      const link = matches[0].cells[0].querySelector('a');
      return link && link.textContent.trim() === String(number) ? link.id : null;
    }, { number, expectedProcedure });
    if (!id) throw new Error('Saved service row could not be identified uniquely');
    await page.locator(`[id=${JSON.stringify(id)}]`).click({ timeout: 8000 });
    await page.waitForLoadState('domcontentloaded');
    await current(selectors.procedure).waitFor({ state: 'visible', timeout: 8000 });
  }
  try {
    await openRow(rowNumber, procedureCode.toUpperCase());
    // Wait for the selected row's server values, not the previous blank editor.
    let savedCode = '';
    for (let poll = 0; poll < 20; poll++) {
      savedCode = String(await current(selectors.procedure).inputValue()).trim().toUpperCase();
      if (savedCode === procedureCode.toUpperCase()) break;
      await page.waitForTimeout(250);
    }
    if (savedCode !== procedureCode.toUpperCase()) throw new Error('Saved procedure was not loaded');
    for (let index = 0; index < modifiers.length; index++) {
      const field = current(selectors.modifiers[index]);
      const actual = await field.evaluate(el => el.tagName.toLowerCase() === 'select'
        ? (el.selectedOptions[0]?.textContent || '') : el.value);
      if (!modifierLabelPattern(modifiers[index]).test(String(actual))) throw new Error(`Saved modifier ${index + 1} is blank or different`);
    }
    // Select the existing blank next row; never Add the saved line twice.
    await openRow(rowNumber + 1, null);
    let blank = false;
    for (let poll = 0; poll < 20; poll++) {
      blank = String(await current(selectors.procedure).inputValue()).trim() === '';
      if (blank) break;
      await page.waitForTimeout(250);
    }
    if (!blank) throw new Error('Next blank service row was not loaded');
    console.log(`SAVED_MODIFIER_VERIFIED: service ${rowNumber} ${procedureCode} modifier ${modifiers.join(', ')} read back from saved row.`);
  } catch (error) {
    throw new Error(`BLOCKED_MODIFIER_COMMIT_UNVERIFIED: ${procedureCode} saved modifier could not be verified (${error.message}). Submit was not clicked.`);
  }
}

module.exports = { modifierLabelPattern, fillPortalModifiers, verifySavedPortalModifiers };
