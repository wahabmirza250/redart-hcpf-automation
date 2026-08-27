// === LOGIN DIAGNOSTIC PATCH (2026-08-27) ===
// Injected after page.fill(password field) and before page.click(login button)
// to compare browser-field values against fetched credentials WITHOUT logging passwords.

const crypto = require('crypto');

// Compute SHA-256 fingerprint of a string
function sha256Fingerprint(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

// Diagnostic function to run AFTER filling login fields but BEFORE clicking submit
async function logLoginFieldDiagnostics(page, fetchedPassword) {
  try {
    const diagnostics = await page.evaluate(async (config) => {
      const usernameField = document.querySelector(config.selectors.login.usernameField);
      const passwordField = document.querySelector(config.selectors.login.passwordField);
      
      return {
        usernameFieldFound: !!usernameField,
        usernameFieldValue: usernameField ? usernameField.value : null,
        usernameFieldLength: usernameField ? usernameField.value.length : null,
        passwordFieldFound: !!passwordField,
        passwordFieldType: passwordField ? passwordField.type : null,
        passwordFieldValue: passwordField ? passwordField.value : null,
        passwordFieldLength: passwordField ? passwordField.value.length : null
      };
    }, { selectors: config.selectors });

    const browserPasswordLength = diagnostics.passwordFieldLength || 0;
    const fetchedPasswordLength = fetchedPassword ? fetchedPassword.length : 0;
    const passwordLengthMatch = browserPasswordLength === fetchedPasswordLength;

    // Compute SHA-256 fingerprints for comparison (do NOT log the actual passwords)
    const browserPasswordFp = diagnostics.passwordFieldValue 
      ? sha256Fingerprint(diagnostics.passwordFieldValue)
      : null;
    const fetchedPasswordFp = fetchedPassword 
      ? sha256Fingerprint(fetchedPassword)
      : null;
    const passwordFingerprintMatch = browserPasswordFp === fetchedPasswordFp;

    console.log('[LOGIN_DIAGNOSTIC]');
    console.log(`  Username field found: ${diagnostics.usernameFieldFound}`);
    console.log(`  Username field value length: ${diagnostics.usernameFieldLength}`);
    console.log(`  Password field found: ${diagnostics.passwordFieldFound}, type: ${diagnostics.passwordFieldType}`);
    console.log(`  Password field value length (browser): ${browserPasswordLength}`);
    console.log(`  Password value length (fetched credential): ${fetchedPasswordLength}`);
    console.log(`  Password length match: ${passwordLengthMatch}`);
    console.log(`  Password SHA-256 fingerprint (browser): ${browserPasswordFp}`);
    console.log(`  Password SHA-256 fingerprint (fetched): ${fetchedPasswordFp}`);
    console.log(`  Password fingerprint match: ${passwordFingerprintMatch}`);
    console.log(`[END_LOGIN_DIAGNOSTIC]`);

    return {
      usernameFound: diagnostics.usernameFieldFound,
      usernameLength: diagnostics.usernameFieldLength,
      passwordFound: diagnostics.passwordFieldFound,
      passwordLength: browserPasswordLength,
      passwordLengthMatch,
      passwordFingerprintMatch,
      browserPasswordFp,
      fetchedPasswordFp
    };
  } catch (err) {
    console.log(`[LOGIN_DIAGNOSTIC] Error during evaluation: ${err.message}`);
    throw err;
  }
}

module.exports = { logLoginFieldDiagnostics, sha256Fingerprint };

