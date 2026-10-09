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

function readSavedServiceRow({ rowNumber, procedureCode, selectors }) {
  const rows = Array.from(document.querySelectorAll('tr')).filter(row => {
    const cells = Array.from(row.cells);
    return cells.length >= 6 && (cells[0].textContent || '').trim() === String(rowNumber)
      && cells.some(cell => (cell.textContent || '').trim().toUpperCase().startsWith(procedureCode.toUpperCase() + '-'));
  });
  if (rows.length !== 1) return null;
  const link = rows[0].cells[0].querySelector('a');
  if (!link?.id || link.textContent.trim() !== String(rowNumber)) return null;
  const editor = rows[0].nextElementSibling;
  const read = selector => {
    if (!selector || !editor) return null;
    const fields = Array.from(editor.querySelectorAll(selector)).filter(el => el.getClientRects().length > 0 && el.type !== 'hidden');
    if (fields.length !== 1) return null;
    const field = fields[0];
    return field.tagName.toLowerCase() === 'select' ? (field.selectedOptions[0]?.textContent || '') : field.value;
  };
  const cancel = editor ? Array.from(editor.querySelectorAll('a,button,input[type="button"]')).filter(el => (el.textContent || el.value || '').trim() === 'Cancel' && el.getClientRects().length > 0) : [];
  return { linkId: link.id, procedure: read(selectors.procedure), modifiers: selectors.modifiers.map(read), cancelId: cancel.length === 1 ? cancel[0].id : null };
}

async function verifySavedPortalModifiers({ page, selectors, rowNumber, procedureCode, modifiers }) {
  // The summary has no modifier column. HCPF opens the saved editor alongside
  // the blank next editor, so a global .last() would read the WRONG service.
  const args = { rowNumber, procedureCode, selectors };
  try {
    const row = await page.evaluate(readSavedServiceRow, args);
    if (!row?.linkId) throw new Error('Saved service row could not be identified uniquely');
    await page.locator(`[id=${JSON.stringify(row.linkId)}]`).click({ timeout: 8000 });
    let saved;
    for (let poll = 0; poll < 20; poll++) {
      saved = await page.evaluate(readSavedServiceRow, args);
      if (saved?.procedure && modifierLabelPattern(procedureCode).test(saved.procedure)) break;
      await page.waitForTimeout(250);
    }
    if (!saved?.procedure || !modifierLabelPattern(procedureCode).test(saved.procedure)) throw new Error('Saved procedure was not loaded');
    for (let index = 0; index < modifiers.length; index++) {
      if (!modifierLabelPattern(modifiers[index]).test(String(saved.modifiers[index] ?? ''))) throw new Error(`Saved modifier ${index + 1} is blank or different`);
    }
    if (!saved.cancelId) throw new Error('Saved editor close control was not identified uniquely');
    // No changes were made. Cancel closes this editor and preserves its saved
    // line; never Save, Remove or Add it again during verification.
    const close = page.locator(`[id=${JSON.stringify(saved.cancelId)}]`);
    await close.click({ timeout: 8000 });
    await close.waitFor({ state: 'hidden', timeout: 8000 });
    console.log(`SAVED_MODIFIER_VERIFIED: service ${rowNumber} ${procedureCode} modifier ${modifiers.join(', ')} read back from saved row.`);
  } catch (error) {
    throw new Error(`BLOCKED_MODIFIER_COMMIT_UNVERIFIED: ${procedureCode} saved modifier could not be verified (${error.message}). Submit was not clicked.`);
  }
}

module.exports = { modifierLabelPattern, fillPortalModifiers, verifySavedPortalModifiers, readSavedServiceRow };
