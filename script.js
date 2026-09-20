// ============================================================
// FIREBASE CONFIGURATION  (SAME AS ADMIN PANEL)
// ============================================================
const firebaseConfig = {
    apiKey: "AIzaSyDbHE3DAFkf73BM1PNH1CeMumIg_fK-MQY",
    authDomain: "lenden-e3c6c.firebaseapp.com",
    databaseURL: "https://lenden-e3c6c-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "lenden-e3c6c",
    storageBucket: "lenden-e3c6c.firebasestorage.app",
    messagingSenderId: "30468884537",
    appId: "1:30468884537:web:36834c69d5131dd59625e8"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ============================================================
// STATE
// ============================================================
let currentAgent = null;
let currentPage = 'home';
let attendanceCache = {};
let additionalPaymentsCache = {};
let salaryPaymentsCache = {};

let loginPending = {
    userId: null,
    agentId: null,
    agentData: null,
    otp: null,
    otpExpiry: 0,
    timerId: null
};

let attPending = {
    status: null,
    otp: null,
    otpExpiry: 0,
    timerId: null
};

const OTP_TTL_SECONDS = 60;
const DUE_SOON_DAYS = 5;

// ============================================================
// UTILITIES
// ============================================================
function formatDate(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parseDateOnly(str) {
    if (!str) return null;
    if (str instanceof Date) return stripTime(str);
    const p = String(str).split('-').map(Number);
    if (p.length !== 3 || p.some(isNaN)) return null;
    return new Date(p[0], p[1]-1, p[2]);
}
function stripTime(date) {
    const d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d, n) {
    const x = new Date(d); x.setDate(x.getDate() + n); return x;
}
// Add months, clamping day-of-month for shorter months.
// ALWAYS re-anchors to the ORIGINAL joining date, so day-of-month
// never drifts (31 Jan → 28 Feb → 31 Mar → 30 Apr → 31 May …).
function addMonthsClamped(d, m) {
    const x = new Date(d);
    const day = x.getDate();
    x.setDate(1);
    x.setMonth(x.getMonth() + m);
    const last = new Date(x.getFullYear(), x.getMonth()+1, 0).getDate();
    x.setDate(Math.min(day, last));
    return x;
}
function daysBetween(a, b) {
    return Math.round((stripTime(b).getTime() - stripTime(a).getTime()) / 86400000);
}
function formatDateLong(s) {
    const d = parseDateOnly(s);
    if (!d) return s || '—';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function formatCurrency(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
function getDaysInMonth(y, m) {
    return new Date(y, m+1, 0).getDate();
}
function generateOTP() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

// ============================================================
// UI HELPERS
// ============================================================
function showLoading(text) {
    document.getElementById('loadingText').textContent = text || 'Loading...';
    document.getElementById('loadingOverlay').classList.remove('hidden');
}
function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}
function showToast(msg, type = 'info') {
    const c = document.getElementById('toastContainer');
    const t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => {
        t.style.transition = 'opacity 0.25s, transform 0.25s';
        t.style.opacity = '0';
        t.style.transform = 'translateY(-10px)';
        setTimeout(() => t.remove(), 250);
    }, 3200);
}
function showErr(id, msg) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.classList.add('show');
}
function clearErr(id) {
    const el = document.getElementById(id);
    el.textContent = '';
    el.classList.remove('show');
}

// ============================================================
// SALARY CYCLE ENGINE  (IDENTICAL TO ADMIN PANEL)
// ============================================================
// Cycle is anchored to the ORIGINAL joining day-of-month.
//   Joining 11 Sep  →  Cycle: 11 Sep → 11 Oct  (due 11 Oct)
//                  →  Cycle: 11 Oct → 11 Nov  (due 11 Nov)
//                  →  Cycle: 11 Nov → 11 Dec  (due 11 Dec)
// No fixed 30-day window. Month length (28/29/30/31) is irrelevant
// to the cycle boundary — the day-of-month is always preserved.
// Handles short months via clamping (e.g. 31 Jan → 28 Feb).
// ============================================================
function getJoiningDate() {
    if (!currentAgent) return null;
    if (currentAgent.joiningDate) return currentAgent.joiningDate;
    let earliest = null;
    Object.keys(attendanceCache).forEach(k => {
        if (attendanceCache[k]?.[currentAgent.id]) {
            if (!earliest || k < earliest) earliest = k;
        }
    });
    return earliest;
}

function getSalaryCycle(joiningDateStr, refDate) {
    const J = parseDateOnly(joiningDateStr);
    if (!J) return null;
    const R = stripTime(refDate);
    if (R < J) return null;

    let n = (R.getFullYear() - J.getFullYear()) * 12 + (R.getMonth() - J.getMonth());
    let start = addMonthsClamped(J, n);
    if (start > R) { n--; start = addMonthsClamped(J, n); }

    let next = addMonthsClamped(J, n+1);
    let guard = 0;
    while (next <= R && guard++ < 500) {
        n++; start = next; next = addMonthsClamped(J, n+1);
    }

    const end = addDays(next, -1);   // last working day of cycle (for attendance calc)
    const dueDate = next;            // next cycle start = payment due date

    return {
        start, end, dueDate,
        startKey: formatDate(start),
        endKey: formatDate(end),
        dueDateKey: formatDate(dueDate),
        key: formatDate(start),
        label: `${formatDateLong(formatDate(start))} → ${formatDateLong(formatDate(dueDate))}`,
        labelWithDue: `${formatDateLong(formatDate(start))} → ${formatDateLong(formatDate(dueDate))}`
    };
}

function getPaymentState(cycle, paid, today) {
    if (paid) return 'paid';
    if (!cycle) return 'in-progress';
    const t = today ? stripTime(today) : stripTime(new Date());
    const d = daysBetween(t, cycle.end);
    if (d < 0) return 'due';
    if (d <= DUE_SOON_DAYS) return 'due-soon';
    return 'in-progress';
}

function calculateCycleSalary(cycle) {
    if (!currentAgent || !cycle) return null;
    const cycleDays = daysBetween(cycle.start, cycle.end) + 1;  // actual calendar days in this cycle
    const monthly = parseFloat(currentAgent.salary) || 0;
    const perDay = cycleDays > 0 ? monthly / cycleDays : 0;
    const today = stripTime(new Date());

    let present = 0, half = 0, absent = 0, unmarked = 0, upcoming = 0;
    for (let i = 0; i < cycleDays; i++) {
        const day = addDays(cycle.start, i);
        if (day > today) { upcoming++; continue; }
        const st = attendanceCache[formatDate(day)]?.[currentAgent.id]?.status;
        if (st === 'present') present++;
        else if (st === 'half') half++;
        else if (st === 'absent') absent++;
        else unmarked++;
    }

    const attSalary = present * perDay + half * perDay * 0.5;
    const baseIncentive = parseFloat(currentAgent.incentive) || 0;

    let addAmount = 0, deductAmount = 0;
    const addlList = [];
    const list = additionalPaymentsCache[currentAgent.id] || {};
    Object.entries(list).forEach(([pid, p]) => {
        if (!p || p.cycleKey !== cycle.key) return;
        addlList.push({ id: pid, ...p });
        const amt = parseFloat(p.amount) || 0;
        if (p.type === 'add') addAmount += amt;
        else if (p.type === 'deduct') deductAmount += amt;
    });

    const final = Math.max(0, Math.round(attSalary + baseIncentive + addAmount - deductAmount));

    let payment = salaryPaymentsCache[currentAgent.id]?.[cycle.key] || null;
    if (!payment) {
        const legacy = cycle.key.slice(0, 7);
        payment = salaryPaymentsCache[legacy]?.[currentAgent.id] || null;
    }
    const paid = payment && payment.status === 'paid';
    const state = getPaymentState(cycle, paid, today);

    return {
        cycle, cycleDays, perDay, monthly,
        present, half, absent, unmarked, upcoming,
        attSalary: Math.round(attSalary),
        baseIncentive, addAmount, deductAmount,
        addlList, final, payment, paid, state
    };
}

// ============================================================
// SESSION (localStorage)
// ============================================================
function saveSession(agentId) {
    localStorage.setItem('agentId', agentId);
}
function clearSession() {
    localStorage.removeItem('agentId');
}
async function restoreSession() {
    const saved = localStorage.getItem('agentId');
    if (!saved) return false;
    showLoading('Verifying session...');
    try {
        const snap = await db.ref('agents/' + saved).get();
        if (snap.exists() && snap.val().status === 'active') {
            currentAgent = { id: saved, ...snap.val() };
            hideLoading();
            return true;
        }
    } catch (e) { console.error(e); }
    clearSession();
    hideLoading();
    return false;
}

// ============================================================
// LOGIN FLOW (credentials only — no OTP on agent side)
// ============================================================
async function submitCredentials() {
    clearErr('loginError1');

    const userId = (document.getElementById('loginUserId').value || '').trim().toUpperCase();
    const password = document.getElementById('loginPassword').value || '';

    if (!userId || !password) {
        showErr('loginError1', 'Please enter both User ID and Password.');
        return;
    }

    const btn = document.getElementById('btnLogin1');
    btn.disabled = true;
    btn.textContent = 'Verifying...';

    try {
        const authSnap = await db.ref('agentAuth/' + userId).get();
        if (!authSnap.exists()) {
            showErr('loginError1', 'Invalid User ID or Password. Contact admin.');
            btn.disabled = false; btn.textContent = 'Continue';
            return;
        }
        const auth = authSnap.val() || {};

        if (String(auth.password) !== String(password)) {
            showErr('loginError1', 'Invalid User ID or Password. Contact admin.');
            btn.disabled = false; btn.textContent = 'Continue';
            return;
        }

        if (auth.active === false) {
            showErr('loginError1', 'Your account is inactive. Contact admin.');
            btn.disabled = false; btn.textContent = 'Continue';
            return;
        }

        const agentId = auth.agentId;
        if (!agentId) {
            showErr('loginError1', 'Account not linked to any agent. Contact admin.');
            btn.disabled = false; btn.textContent = 'Continue';
            return;
        }
        const agentSnap = await db.ref('agents/' + agentId).get();
        if (!agentSnap.exists()) {
            showErr('loginError1', 'Agent record not found. Contact admin.');
            btn.disabled = false; btn.textContent = 'Continue';
            return;
        }
        const agentData = agentSnap.val() || {};
        if (agentData.status !== 'active') {
            showErr('loginError1', 'Your account is not active. Contact admin.');
            btn.disabled = false; btn.textContent = 'Continue';
            return;
        }

        currentAgent = { id: agentId, ...agentData };
        saveSession(agentId);

        btn.disabled = false; btn.textContent = 'Continue';
        showToast('Login successful', 'success');
        enterApp();
    } catch (e) {
        console.error(e);
        showErr('loginError1', 'Network error. Please try again.');
        btn.disabled = false; btn.textContent = 'Continue';
    }
}

// Legacy login OTP helpers (kept for compatibility, not part of current flow)
function goToLoginOtpStep() {
    loginPending.otp = generateOTP();
    loginPending.otpExpiry = Date.now() + OTP_TTL_SECONDS * 1000;
    document.getElementById('loginStep1').classList.add('hidden');
    document.getElementById('loginStep2').classList.remove('hidden');
    document.getElementById('loginOtpCode').textContent = loginPending.otp;
    document.getElementById('loginOtpInput').value = '';
    clearErr('loginError2');
    startOtpTimer(
        'loginOtpTimer',
        'Valid for {s}s',
        () => loginPending.otpExpiry,
        () => { /* expired */ }
    );
    setTimeout(() => document.getElementById('loginOtpInput').focus(), 100);
}

function backToLoginStep1() {
    stopOtpTimer(loginPending.timerId);
    loginPending.otp = null;
    document.getElementById('loginStep2')?.classList.add('hidden');
    document.getElementById('loginStep1')?.classList.remove('hidden');
    const inp = document.getElementById('loginOtpInput');
    if (inp) inp.value = '';
    clearErr('loginError2');
}

function submitLoginOtp() {
    clearErr('loginError2');
    const entered = (document.getElementById('loginOtpInput').value || '').trim();
    if (!entered || entered.length !== 6) {
        showErr('loginError2', 'Please enter the 6-digit OTP.');
        return;
    }
    if (Date.now() > loginPending.otpExpiry) {
        showErr('loginError2', 'OTP expired. Go back and try again.');
        return;
    }
    if (entered !== loginPending.otp) {
        showErr('loginError2', 'Incorrect OTP. Please try again.');
        return;
    }
    stopOtpTimer(loginPending.timerId);
    currentAgent = { id: loginPending.agentId, ...loginPending.agentData };
    saveSession(loginPending.agentId);
    loginPending = { userId: null, agentId: null, agentData: null, otp: null, otpExpiry: 0, timerId: null };
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginOtpInput').value = '';
    showToast('Login successful', 'success');
    enterApp();
}

// ============================================================
// TIMER helpers
// ============================================================
function startOtpTimer(timerElId, fmt, getExpiry, onExpire) {
    stopOtpTimer(loginPending.timerId);
    stopOtpTimer(attPending.timerId);

    const tick = () => {
        const remain = Math.max(0, Math.ceil((getExpiry() - Date.now()) / 1000));
        const el = document.getElementById(timerElId);
        if (el) {
            el.textContent = fmt.replace('{s}', remain);
            if (remain === 0) el.classList.add('expired');
            else el.classList.remove('expired');
        }
        if (remain === 0) {
            onExpire && onExpire();
        }
    };
    tick();
    const id = setInterval(tick, 500);
    if (timerElId === 'loginOtpTimer') loginPending.timerId = id;
    else if (timerElId === 'attOtpTimer') attPending.timerId = id;
}
function stopOtpTimer(id) {
    if (id) clearInterval(id);
}

// ============================================================
// APP INIT
// ============================================================
function enterApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').classList.remove('hidden');
    startDataListeners();
    navigateTo('home');
}
function doLogout() {
    stopOtpTimer(loginPending.timerId);
    stopOtpTimer(attPending.timerId);
    clearSession();
    currentAgent = null;
    document.getElementById('appScreen').classList.add('hidden');
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('loginUserId').value = '';
    document.getElementById('loginPassword').value = '';
    clearErr('loginError1');
    clearErr('loginError2');
    backToLoginStep1();
    showToast('Logged out', 'info');
}

// ============================================================
// DATA LISTENERS
// ============================================================
let listenersStarted = false;
function startDataListeners() {
    if (listenersStarted) return;
    listenersStarted = true;

    db.ref('attendance').on('value', snap => {
        attendanceCache = snap.val() || {};
        if (currentAgent) renderPage();
    }, e => console.error('attendance:', e));

    db.ref('additionalPayments').on('value', snap => {
        additionalPaymentsCache = snap.val() || {};
        if (currentAgent && currentPage === 'salary') renderPage();
    }, e => console.error('additionalPayments:', e));

    db.ref('salaryPayments').on('value', snap => {
        salaryPaymentsCache = snap.val() || {};
        if (currentAgent && currentPage === 'salary') renderPage();
    }, e => console.error('salaryPayments:', e));
}

// ============================================================
// NAVIGATION
// ============================================================
function navigateTo(page) {
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(b => {
        b.classList.toggle('active', b.dataset.page === page);
    });
    renderPage();
}
function renderPage() {
    if (!currentAgent) return;
    switch (currentPage) {
        case 'home': renderHome(); break;
        case 'attendance': renderAttendance(); break;
        case 'history': renderHistory(); break;
        case 'salary': renderSalary(); break;
    }
}

// ============================================================
// PAGE 1: HOME
// ============================================================
function renderHome() {
    const joining = getJoiningDate();
    const cycle = joining ? getSalaryCycle(joining, stripTime(new Date())) : null;

    let cycleHtml = '';
    if (cycle) {
        // Actual calendar days in this cycle (28/29/30/31 — never fixed)
        const cycleDays = daysBetween(cycle.start, cycle.end) + 1;
        const dayInCycle = Math.min(daysBetween(cycle.start, stripTime(new Date())) + 1, cycleDays);
        const pct = Math.min(100, Math.round((dayInCycle / cycleDays) * 100));
        const daysLeft = Math.max(0, cycleDays - dayInCycle);

        cycleHtml = `
            <div class="card">
                <div class="card-head">
                    <div class="title"><span class="icon">📆</span>Current Salary Cycle</div>
                </div>
                <div class="card-body">
                    <div class="cycle-range">${formatDateLong(cycle.startKey)} → ${formatDateLong(cycle.dueDateKey)}</div>
                    <div class="cycle-day">Day ${dayInCycle} of ${cycleDays}</div>
                    <div class="progress"><span style="width:${pct}%"></span></div>
                    <div class="progress-info">
                        <span>Started ${formatDateLong(cycle.startKey)}</span>
                        <span>Payment due ${formatDateLong(cycle.dueDateKey)}</span>
                    </div>
                </div>
            </div>
        `;
    } else {
        cycleHtml = `
            <div class="card">
                <div class="card-head">
                    <div class="title"><span class="icon">📆</span>Current Salary Cycle</div>
                </div>
                <div class="card-body">
                    <div style="text-align:center;font-size:13px;color:var(--gray-500);">
                        Your salary cycle will be set up once your joining date is recorded.
                    </div>
                </div>
            </div>
        `;
    }

    const today = formatDate(new Date());
    const todayStatus = attendanceCache[today]?.[currentAgent.id]?.status || 'unmarked';
    const todayCfg = {
        present: { txt: 'Present', ic: '✅' },
        half: { txt: 'Half Day', ic: '⏳' },
        absent: { txt: 'Non-Present', ic: '❌' },
        unmarked: { txt: 'Not Marked', ic: '⚪' }
    };
    const t = todayCfg[todayStatus];

    document.getElementById('mainContent').innerHTML = `
        <div class="hero">
            <div class="hero-greeting">Welcome back,</div>
            <div class="hero-name">${currentAgent.name.split(' ')[0]}</div>
            <div class="hero-status">
                <span>${t.ic}</span>
                <span>Today: ${t.txt}</span>
            </div>
        </div>

        <div class="card">
            <div class="card-head">
                <div class="title"><span class="icon">👤</span>Your Profile</div>
            </div>
            <div class="card-body">
                <div class="row">
                    <span class="label">Full Name</span>
                    <span class="value">${currentAgent.name || '—'}</span>
                </div>
                <div class="row">
                    <span class="label">User ID</span>
                    <span class="value">${currentAgent.userId || '—'}</span>
                </div>
                <div class="row">
                    <span class="label">Joining Date</span>
                    <span class="value">${joining ? formatDateLong(joining) : 'Not set'}</span>
                </div>
            </div>
        </div>

        ${cycleHtml}

        <button class="action-btn" onclick="navigateTo('attendance')">
            <div class="ico blue">✅</div>
            <div class="txt">
                <div class="t">Mark Today's Attendance</div>
                <div class="s">Present (needs OTP) · Non-Present</div>
            </div>
            <div class="arrow">›</div>
        </button>

        <button class="action-btn" onclick="navigateTo('salary')">
            <div class="ico purple">💰</div>
            <div class="txt">
                <div class="t">View Current Cycle Salary</div>
                <div class="s">Attendance earnings, payments & final amount</div>
            </div>
            <div class="arrow">›</div>
        </button>
    `;
}

// ============================================================
// PAGE 2: ATTENDANCE
// ============================================================
function renderAttendance() {
    const today = formatDate(new Date());
    const rec = attendanceCache[today]?.[currentAgent.id];
    const st = rec?.status || 'unmarked';
    const locked = st !== 'unmarked';

    const statusLabel = st === 'present' ? 'Present'
                      : st === 'half' ? 'Half Day'
                      : st === 'absent' ? 'Non-Present'
                      : 'Unmarked';

    const markedInfo = locked ? `
        <div class="info-box ok">
            ✅ You have already marked <strong>${statusLabel}</strong> today.<br>
            <span style="font-weight:500;font-size:11.5px;opacity:0.8;">Attendance is locked for today. Contact admin to make changes.</span>
        </div>
    ` : `
        <div class="info-box warn">
            ⚠️ Your attendance for today is not marked yet.
        </div>
    `;

    document.getElementById('mainContent').innerHTML = `
        <div class="page-title">Mark Attendance</div>
        <div class="page-sub">${new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div>

        <div class="att-actions">
            <button class="att-big present ${st==='present'?'active':''}"
                    onclick="openAttendanceOtp('present')" ${locked?'disabled':''}>
                <span class="ic">✅</span>
                <div>
                    <div class="lbl">Present</div>
                    <div class="sub">Requires OTP from Admin</div>
                </div>
            </button>
            <button class="att-big absent ${st==='absent'?'active':''}"
                    onclick="markNonPresent()" ${locked?'disabled':''}>
                <span class="ic">❌</span>
                <div>
                    <div class="lbl">Non-Present</div>
                    <div class="sub">No OTP required</div>
                </div>
            </button>
        </div>

        ${markedInfo}
    `;
}

// ============================================================
// MARK NON-PRESENT (direct — no OTP)
// ============================================================
async function markNonPresent() {
    const today = formatDate(new Date());

    if (attendanceCache[today]?.[currentAgent.id]?.status) {
        showToast('Attendance already marked for today.', 'warning');
        return;
    }

    if (!confirm('Mark today as Non-Present? This will be recorded as Absent and cannot be changed from the agent panel.')) {
        return;
    }

    try {
        await db.ref(`attendance/${today}/${currentAgent.id}`).set({
            status: 'absent',
            markedAt: firebase.database.ServerValue.TIMESTAMP,
            markedBy: 'agent_self'
        });
        showToast('Marked as Non-Present', 'success');
        renderAttendance();
    } catch (e) {
        console.error(e);
        showToast('Failed to save. Check your connection.', 'error');
    }
}

// ============================================================
// OTP MODAL — for Present (Admin-generated OTP only)
// ============================================================
function openAttendanceOtp(status) {
    if (status !== 'present') return;

    const today = formatDate(new Date());
    if (attendanceCache[today]?.[currentAgent.id]?.status) {
        showToast('Attendance already marked for today.', 'warning');
        return;
    }

    attPending.status = 'present';
    document.getElementById('otpStatusLabel').textContent = 'Present';

    const codeEl = document.getElementById('attOtpCode');
    const timerEl = document.getElementById('attOtpTimer');
    if (codeEl) codeEl.textContent = '••••••';
    if (timerEl) {
        timerEl.textContent = 'Enter the OTP shared by Admin (valid whole day)';
        timerEl.classList.remove('expired');
    }

    document.getElementById('otpInput').value = '';
    clearErr('otpError');
    document.getElementById('otpModal').classList.add('active');
    setTimeout(() => document.getElementById('otpInput').focus(), 100);
}

function closeOtpModal() {
    stopOtpTimer(attPending.timerId);
    attPending.status = null;
    attPending.otp = null;
    attPending.otpExpiry = 0;
    document.getElementById('otpModal').classList.remove('active');
}

// ============================================================
// VERIFY OTP & mark Present
// ============================================================
async function confirmAttendanceOtp() {
    clearErr('otpError');

    const entered = (document.getElementById('otpInput').value || '').trim();
    if (!entered || entered.length !== 6) {
        showErr('otpError', 'Please enter the 6-digit OTP shared by Admin.');
        return;
    }

    const today = formatDate(new Date());

    if (attendanceCache[today]?.[currentAgent.id]?.status) {
        showErr('otpError', 'Attendance already marked for today.');
        return;
    }

    const btn = document.getElementById('otpConfirmBtn');
    btn.disabled = true;
    btn.textContent = 'Verifying...';

    try {
        const snap = await db.ref('otp/' + currentAgent.id).get();
        const otpData = snap.val();

        if (!otpData) {
            showErr('otpError', 'No OTP found for you. Ask Admin to generate one.');
            btn.disabled = false; btn.textContent = 'Verify & Save';
            return;
        }

        const validDate = otpData.validDate || otpData.date;
        if (validDate !== today) {
            showErr('otpError', 'OTP is not valid for today. Ask Admin for today\'s OTP.');
            btn.disabled = false; btn.textContent = 'Verify & Save';
            return;
        }
        if (otpData.expiresAt && Date.now() > Number(otpData.expiresAt)) {
            showErr('otpError', 'OTP has expired. Ask Admin for a new one.');
            btn.disabled = false; btn.textContent = 'Verify & Save';
            return;
        }
        if (otpData.used === true) {
            showErr('otpError', 'This OTP has already been used today.');
            btn.disabled = false; btn.textContent = 'Verify & Save';
            return;
        }
        if (String(otpData.otp) !== entered) {
            showErr('otpError', 'Incorrect OTP. Please check and try again.');
            btn.disabled = false; btn.textContent = 'Verify & Save';
            return;
        }

        await db.ref(`attendance/${today}/${currentAgent.id}`).set({
            status: 'present',
            markedAt: firebase.database.ServerValue.TIMESTAMP,
            markedBy: 'agent_self',
            viaOtp: true
        });
        await db.ref(`otp/${currentAgent.id}`).update({
            used: true,
            usedAt: firebase.database.ServerValue.TIMESTAMP
        });

        showToast('Present marked successfully', 'success');
        closeOtpModal();
        renderAttendance();
    } catch (e) {
        console.error(e);
        showErr('otpError', 'Verification failed. Check your connection.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Verify & Save';
    }
}

// ============================================================
// PAGE 3: HISTORY  (current month only, own data)
// ============================================================
function renderHistory() {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth();
    const daysInMonth = getDaysInMonth(y, m);

    let present = 0, half = 0, absent = 0;
    let rowsHtml = '';
    let has = false;

    for (let d = daysInMonth; d >= 1; d--) {
        const dt = new Date(y, m, d);
        const key = formatDate(dt);
        const st = attendanceCache[key]?.[currentAgent.id]?.status || 'unmarked';

        if (st === 'present') present++;
        else if (st === 'half') half++;
        else if (st === 'absent') absent++;

        if (st !== 'unmarked' || d === today.getDate()) {
            has = true;
            const map = {
                present: '<span class="badge badge-success">Present</span>',
                half: '<span class="badge badge-warning">Half Day</span>',
                absent: '<span class="badge badge-danger">Non-Present</span>',
                unmarked: '<span class="badge badge-gray">Unmarked</span>'
            };
            rowsHtml += `
                <div class="history-item">
                    <div>
                        <div class="history-date">${dt.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</div>
                        <div class="history-day">${dt.toLocaleDateString('en-IN',{weekday:'long'})}</div>
                    </div>
                    ${map[st]}
                </div>
            `;
        }
    }

    const monthLabel = today.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

    document.getElementById('mainContent').innerHTML = `
        <div class="page-title">Attendance History</div>
        <div class="page-sub">${monthLabel}</div>

        <div class="card">
            <div class="card-body" style="padding-top:4px;padding-bottom:4px;">
                <div class="summary-strip">
                    <div>
                        <div class="num num-p">${present}</div>
                        <div class="lbl">Present</div>
                    </div>
                    <div>
                        <div class="num num-h">${half}</div>
                        <div class="lbl">Half</div>
                    </div>
                    <div>
                        <div class="num num-a">${absent}</div>
                        <div class="lbl">Non-Present</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-body">
                ${has ? rowsHtml : `
                    <div class="empty-state">
                        <div class="ei">📅</div>
                        <div class="et">No records yet</div>
                        <div class="es">Attendance for this month will appear here.</div>
                    </div>
                `}
            </div>
        </div>
    `;
}

// ============================================================
// PAGE 4: SALARY  (cycle-based, calendar-anchored, read-only)
// ============================================================
function renderSalary() {
    const joining = getJoiningDate();

    if (!joining) {
        document.getElementById('mainContent').innerHTML = `
            <div class="page-title">Salary</div>
            <div class="page-sub">Current cycle</div>
            <div class="card">
                <div class="card-body">
                    <div class="empty-state">
                        <div class="ei">💰</div>
                        <div class="et">Salary cycle not set up</div>
                        <div class="es">Ask admin to set your joining date.</div>
                    </div>
                </div>
            </div>
        `;
        return;
    }

    const cycle = getSalaryCycle(joining, stripTime(new Date()));
    if (!cycle) {
        document.getElementById('mainContent').innerHTML = `
            <div class="page-title">Salary</div>
            <div class="page-sub">Current cycle</div>
            <div class="card">
                <div class="card-body">
                    <div class="empty-state">
                        <div class="ei">💰</div>
                        <div class="et">No active salary cycle yet</div>
                    </div>
                </div>
            </div>
        `;
        return;
    }

    const data = calculateCycleSalary(cycle);
    if (!data) return;

    const dayInCycle = Math.min(daysBetween(cycle.start, stripTime(new Date())) + 1, data.cycleDays);

    const stateLabel = data.state === 'paid' ? '✓ Paid'
                     : data.state === 'due' ? '⏳ Pending'
                     : data.state === 'due-soon' ? '⏳ Due Soon'
                     : '🕐 In Progress';

    let addlHtml = '';
    if (data.addlList.length > 0) {
        addlHtml = data.addlList.map(p => {
            const color = p.type === 'add' ? 'var(--success)' : p.type === 'deduct' ? 'var(--danger)' : 'var(--gray-500)';
            const sign = p.type === 'add' ? '+' : p.type === 'deduct' ? '−' : '';
            return `
                <div class="row">
                    <div>
                        <div style="font-weight:600;font-size:13px;color:var(--gray-800);">${p.reason || 'Payment'}</div>
                        <div style="font-size:11.5px;color:var(--gray-500);">${formatDateLong(p.date)}</div>
                    </div>
                    <span class="value" style="color:${color};">${sign}${formatCurrency(p.amount)}</span>
                </div>
            `;
        }).join('');
    }

    document.getElementById('mainContent').innerHTML = `
        <div class="page-title">Salary</div>
        <div class="page-sub">Current Cycle</div>

        <div class="salary-hero">
            <div class="lbl">Estimated Final Salary</div>
            <div class="amt">${formatCurrency(data.final)}</div>
            <div class="status-chip">${stateLabel}</div>
        </div>

        <div class="card">
            <div class="card-head">
                <div class="title"><span class="icon">📆</span>Cycle</div>
            </div>
            <div class="card-body">
                <div class="row">
                    <span class="label">Cycle</span>
                    <span class="value">${formatDateLong(cycle.startKey)} → ${formatDateLong(cycle.dueDateKey)}</span>
                </div>
                <div class="row">
                    <span class="label">Payment Due</span>
                    <span class="value" style="color:var(--success);font-weight:700;">${formatDateLong(cycle.dueDateKey)}</span>
                </div>
                <div class="row">
                    <span class="label">Progress</span>
                    <span class="value">Day ${dayInCycle} of ${data.cycleDays}</span>
                </div>
                <div class="row">
                    <span class="label">Per Day Salary</span>
                    <span class="value">${formatCurrency(data.perDay)}</span>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-head">
                <div class="title"><span class="icon">📊</span>Attendance in Cycle</div>
            </div>
            <div class="card-body">
                <div class="row">
                    <span class="label">Present (${data.present})</span>
                    <span class="value" style="color:var(--success);">+ ${formatCurrency(data.present * data.perDay)}</span>
                </div>
                <div class="row">
                    <span class="label">Half Days (${data.half})</span>
                    <span class="value" style="color:var(--warning);">+ ${formatCurrency(data.half * data.perDay * 0.5)}</span>
                </div>
                <div class="row">
                    <span class="label">Non-Present (${data.absent})</span>
                    <span class="value" style="color:var(--danger);">₹0</span>
                </div>
                <div class="row">
                    <span class="label">Unmarked (${data.unmarked})</span>
                    <span class="value" style="font-size:12px;color:var(--gray-400);font-weight:500;">Not deducted</span>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-head">
                <div class="title"><span class="icon">💰</span>Final Calculation</div>
            </div>
            <div class="card-body">
                <div class="row">
                    <span class="label">Attendance Earnings</span>
                    <span class="value">${formatCurrency(data.attSalary)}</span>
                </div>
                <div class="row">
                    <span class="label">Base Incentive</span>
                    <span class="value" style="color:var(--success);">+ ${formatCurrency(data.baseIncentive)}</span>
                </div>
                ${data.addAmount > 0 ? `
                <div class="row">
                    <span class="label">Additional Payments</span>
                    <span class="value" style="color:var(--success);">+ ${formatCurrency(data.addAmount)}</span>
                </div>` : ''}
                ${data.deductAmount > 0 ? `
                <div class="row">
                    <span class="label">Deductions</span>
                    <span class="value" style="color:var(--danger);">− ${formatCurrency(data.deductAmount)}</span>
                </div>` : ''}
                <div class="row" style="border-top:2px solid var(--gray-200);margin-top:8px;padding-top:12px;border-bottom:none;">
                    <span class="label" style="font-weight:700;color:var(--gray-700);">Final Payable</span>
                    <span class="value" style="font-size:17px;color:var(--primary);">${formatCurrency(data.final)}</span>
                </div>
            </div>
        </div>

        ${data.addlList.length > 0 ? `
        <div class="card">
            <div class="card-head">
                <div class="title"><span class="icon">💵</span>Additional Payments</div>
            </div>
            <div class="card-body">
                ${addlHtml}
            </div>
        </div>
        ` : ''}

        ${data.paid && data.payment?.paidAt ? `
        <div class="card" style="background:var(--success-light);border-color:#a7f3d0;">
            <div class="card-body" style="text-align:center;">
                <div style="font-size:13px;font-weight:800;color:var(--success);margin-bottom:4px;">✓ Salary Paid</div>
                <div style="font-size:12px;color:var(--gray-600);">
                    Paid on ${new Date(data.payment.paidAt).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}
                </div>
            </div>
        </div>
        ` : ''}

        <div class="card" style="background:var(--gray-100);border:none;">
            <div class="card-body" style="text-align:center;padding:14px;">
                <div style="font-size:11.5px;color:var(--gray-600);line-height:1.5;">
                    💡 <strong>Note:</strong> Salary cycle is anchored to your joining date-of-month.<br>
                    Unmarked days are never treated as absent. Contact admin for any discrepancy.
                </div>
            </div>
        </div>
    `;
}

// ============================================================
// INIT
// ============================================================
(async function boot() {
    document.getElementById('appScreen').classList.add('hidden');
    document.getElementById('loginScreen').style.display = 'flex';

    document.getElementById('loginStep2')?.classList.add('hidden');

    const restored = await restoreSession();
    if (restored) {
        enterApp();
    }
})();