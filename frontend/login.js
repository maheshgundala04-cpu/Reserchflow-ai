const API_BASE_URL = '/api';

const EMAILJS_PUBLIC_KEY = 'jvApKmfjq5s5O8p4B';
const EMAILJS_SERVICE_ID = 'service_ggmal9k';
const EMAILJS_TEMPLATE_ID = 'template_k3oj464';

if (window.emailjs) {
    emailjs.init({
        publicKey: EMAILJS_PUBLIC_KEY
    });
}

let currentEmail = '';
let tempUserData = null;

function showLoginError(message) {
    const errorDiv = document.getElementById('loginError');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.classList.remove('hidden');
    }
}

function clearLoginError() {
    const errorDiv = document.getElementById('loginError');
    if (errorDiv) {
        errorDiv.classList.add('hidden');
    }
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidName(name) {
    return typeof name === 'string' && name.trim().length >= 2;
}

function isValidMobile(mobile) {
    return /^[6-9]\d{9}$/.test(mobile.trim());
}

async function requestBackendOtpAndSendEmail(email, name) {
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email })
    });

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to generate verification code.');
    }

    const data = await response.json();
    const otpCode = data.devOtp;

    let sentViaEmailJs = false;

    // If backend didn't send via SMTP, send via EmailJS
    if (otpCode && window.emailjs) {
        try {
            await emailjs.send(
                EMAILJS_SERVICE_ID,
                EMAILJS_TEMPLATE_ID,
                {
                    email: email,
                    name: name || email.split('@')[0],
                    otp: otpCode
                }
            );
            sentViaEmailJs = true;
        } catch (emailErr) {
            console.warn('EmailJS fallback triggered:', emailErr);
        }
    }

    const alertSpan = document.querySelector('#otpForm .otp-alert span');
    if (alertSpan) {
        if (sentViaEmailJs || !otpCode) {
            alertSpan.textContent = `Check ${email} for the 6-digit verification code.`;
        } else {
            alertSpan.textContent = `Verification code: ${otpCode}`;
        }
    }
}

function resetLoginButtons() {
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.innerHTML = '<span>Send Verification Code</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
    }
    const detailsSubmitBtn = document.getElementById('detailsSubmitBtn');
    if (detailsSubmitBtn) {
        detailsSubmitBtn.disabled = false;
        detailsSubmitBtn.innerHTML = '<span>Send Verification Code</span>';
    }
    const verifyBtn = document.getElementById('verifyBtn');
    if (verifyBtn) {
        verifyBtn.disabled = false;
        verifyBtn.innerHTML = '<span>Verify & Login</span>';
    }
}

// Standard Email Login Form
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = document.getElementById('emailInput').value.trim().toLowerCase();
    const loginBtn = document.getElementById('loginBtn');

    if (!isValidEmail(email)) {
        showLoginError('Please enter a valid email address.');
        return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = 'Sending...';
    clearLoginError();
    tempUserData = null;

    try {
        await requestBackendOtpAndSendEmail(email, email.split('@')[0]);
        currentEmail = email;

        document.getElementById('loginForm').classList.add('hidden');
        document.getElementById('detailsForm').classList.add('hidden');
        document.getElementById('otpForm').classList.remove('hidden');
        document.getElementById('otpInput').focus();
    } catch (error) {
        console.error('EmailJS / Login error:', error);
        showLoginError(error?.text || error?.message || 'Failed to send verification code. Please try again.');
        resetLoginButtons();
    }
});

// Details Form (from Google Sign-In)
document.getElementById('detailsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearLoginError();

    const nameInput = document.getElementById('uname').value.trim();
    const mobileInput = document.getElementById('umobile').value.trim();
    const detailsSubmitBtn = document.getElementById('detailsSubmitBtn');

    if (!isValidName(nameInput)) {
        showLoginError('Please enter a valid full name.');
        return;
    }

    if (!isValidMobile(mobileInput)) {
        showLoginError('Please enter a valid 10-digit Indian mobile number.');
        return;
    }

    if (!tempUserData || !tempUserData.email) {
        showLoginError('Session expired. Please start again.');
        return;
    }

    tempUserData.name = nameInput;
    tempUserData.mobile = mobileInput;

    detailsSubmitBtn.disabled = true;
    detailsSubmitBtn.textContent = 'Sending Code...';

    try {
        await requestBackendOtpAndSendEmail(tempUserData.email, tempUserData.name);
        currentEmail = tempUserData.email;

        document.getElementById('detailsForm').classList.add('hidden');
        document.getElementById('otpForm').classList.remove('hidden');
        document.getElementById('otpInput').focus();
    } catch (error) {
        console.error('EmailJS / Details error:', error);
        showLoginError(error?.text || error?.message || 'Failed to send OTP.');
        resetLoginButtons();
    }
});

// OTP Verification Form
document.getElementById('otpForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const otp = document.getElementById('otpInput').value.trim();
    const verifyBtn = document.getElementById('verifyBtn');

    if (!otp) return;

    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying...';
    clearLoginError();

    try {
        const response = await fetch(`${API_BASE_URL}/auth/verify-otp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email: currentEmail, otp: otp })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.detail || 'Incorrect or expired verification code.');
        }

        const data = await response.json();

        if (tempUserData && tempUserData.email === currentEmail) {
            tempUserData.loginDate = new Date().toLocaleDateString();
            tempUserData.loginTime = new Date().toLocaleTimeString();
            localStorage.setItem(tempUserData.email, JSON.stringify(tempUserData));
        }

        localStorage.setItem('userEmail', data.email);
        window.location.href = 'index.html';
    } catch (error) {
        showLoginError(error.message);
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify & Login';
    }
});

// Google Email Modal Helpers
function openGoogleInputBox() {
    const modal = document.getElementById('google-prompt-modal');
    const modalErr = document.getElementById('googleModalError');
    const input = document.getElementById('google-email-input');
    if (modalErr) modalErr.classList.add('hidden');
    if (modal) modal.classList.remove('hidden');
    if (input) input.focus();
}

function closeGoogleInputBox() {
    const modal = document.getElementById('google-prompt-modal');
    if (modal) modal.classList.add('hidden');
}

async function submitGoogleEmail() {
    const gEmail = document.getElementById('google-email-input').value.trim().toLowerCase();
    const modalErr = document.getElementById('googleModalError');

    if (!isValidEmail(gEmail)) {
        if (modalErr) {
            modalErr.textContent = 'Please enter a valid email address.';
            modalErr.classList.remove('hidden');
        }
        return;
    }

    closeGoogleInputBox();
    clearLoginError();

    const existingRaw = localStorage.getItem(gEmail);
    if (existingRaw) {
        try {
            const existing = JSON.parse(existingRaw);
            if (existing.name && existing.mobile && existing.mobile !== 'Not Provided') {
                // Ensure backend user record exists for returning user
                const loginRes = await fetch(`${API_BASE_URL}/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: gEmail })
                });
                if (loginRes.ok) {
                    const loginData = await loginRes.json();
                    if (loginData.devOtp) {
                        await fetch(`${API_BASE_URL}/auth/verify-otp`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: gEmail, otp: loginData.devOtp })
                        });
                    }
                    existing.loginDate = new Date().toLocaleDateString();
                    existing.loginTime = new Date().toLocaleTimeString();
                    localStorage.setItem(gEmail, JSON.stringify(existing));
                    localStorage.setItem('userEmail', gEmail);
                    window.location.href = 'index.html';
                    return;
                }
            }
            tempUserData = existing;
        } catch {
            tempUserData = { email: gEmail, name: '', mobile: '' };
        }
    } else {
        tempUserData = { email: gEmail, name: '', mobile: '' };
    }

    document.getElementById('display-email').value = tempUserData.email;
    document.getElementById('uname').value = tempUserData.name || '';
    document.getElementById('umobile').value = tempUserData.mobile || '';

    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('otpForm').classList.add('hidden');
    document.getElementById('detailsForm').classList.remove('hidden');
    document.getElementById('uname').focus();
}

// Navigation & Modal Event Bindings
document.getElementById('googleSignInBtn')?.addEventListener('click', openGoogleInputBox);
document.getElementById('googleCancelBtn')?.addEventListener('click', closeGoogleInputBox);
document.getElementById('googleNextBtn')?.addEventListener('click', submitGoogleEmail);
document.getElementById('google-email-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        submitGoogleEmail();
    }
});

document.getElementById('backBtn')?.addEventListener('click', () => {
    document.getElementById('otpForm').classList.add('hidden');
    document.getElementById('detailsForm').classList.add('hidden');
    document.getElementById('loginForm').classList.remove('hidden');
    clearLoginError();
    resetLoginButtons();
});

document.getElementById('detailsBackBtn')?.addEventListener('click', () => {
    document.getElementById('detailsForm').classList.add('hidden');
    document.getElementById('otpForm').classList.add('hidden');
    document.getElementById('loginForm').classList.remove('hidden');
    clearLoginError();
    resetLoginButtons();
});

// Typing Animation
function initTypewriter(id, words) {
    const el = document.getElementById(id);
    if (!el) return;
    let wordIdx = 0;
    let charIdx = 0;
    let isDeleting = false;

    function type() {
        const currentWord = words[wordIdx];
        if (isDeleting) {
            el.textContent = currentWord.substring(0, charIdx - 1);
            charIdx--;
        } else {
            el.textContent = currentWord.substring(0, charIdx + 1);
            charIdx++;
        }

        let typeSpeed = isDeleting ? 50 : 100;

        if (!isDeleting && charIdx === currentWord.length) {
            isDeleting = true;
            typeSpeed = 2000;
        } else if (isDeleting && charIdx === 0) {
            isDeleting = false;
            wordIdx = (wordIdx + 1) % words.length;
            typeSpeed = 500;
        }

        setTimeout(type, typeSpeed);
    }
    type();
}

document.addEventListener('DOMContentLoaded', () => {
    initTypewriter('loginTyping', ["Analyze. Compare. Evolve.", "Your AI Memento System.", "Secure Academic Access."]);
});
