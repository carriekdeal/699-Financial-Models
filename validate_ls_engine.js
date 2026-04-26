#!/usr/bin/env node
// Validation tests — lump sum engine with correct two-transaction architecture

const round2 = v => Math.round(v * 100) / 100;
const DRAW_MONTHS     = 240;
const MAX_LOAN_MONTHS = 480;

function getLumpSumForMonth(lsRules, monthNum, startDateStr) {
  let total = 0;
  for (const r of lsRules) {
    const s = r.startMonth || 1;
    switch (r.cadence) {
      case 'once':
        if (monthNum === s) total += r.amount;
        break;
      case 'annually':
        if (monthNum >= s && (monthNum - s) % 12 === 0) total += r.amount;
        break;
      case 'biannually':
        if (monthNum >= s && (monthNum - s) % 6  === 0) total += r.amount;
        break;
      case 'quarterly':
        if (monthNum >= s && (monthNum - s) % 3  === 0) total += r.amount;
        break;
      case 'custom': {
        let fires = false;
        if (r.calendarMonth) {
          const smNum    = parseInt((startDateStr || '').split('-')[1] || '1', 10);
          const calMonth = ((smNum + monthNum - 2) % 12) + 1;
          if (calMonth === r.calendarMonth) fires = true;
        }
        if (!fires && r.interval > 0) {
          const s2 = r.startMonth || 1;
          if (monthNum >= s2 && (monthNum - s2) % r.interval === 0) fires = true;
        }
        if (fires) total += r.amount;
        break;
      }
    }
  }
  return total;
}

function getContribForMonth(baseContrib, changeRules, monthNum) {
  let amount = baseContrib;
  for (const r of changeRules) {
    if (r.startMonth <= monthNum) amount = r.amount;
    else break;
  }
  return amount;
}

// Calendar month number (1-12) → loan month number
function calendarMonthToLoanMonth(startDateStr, calYear, calMonth) {
  const [sy, sm] = startDateStr.split('-').map(Number);
  return (calYear - sy) * 12 + (calMonth - sm) + 1;
}

function monthNumToDate(startDateStr, monthOffset) {
  const [y, m] = startDateStr.split('-').map(Number);
  const dt = new Date(y, m + monthOffset - 2, 1);
  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function runAmortization(params) {
  const { balance, annualRate, minPctPerMonth, baseContrib,
          contribRules, lsRules, solverLsRules, startDateStr, maxMonths,
          housingTarget, fixedObligation } = params;

  const monthlyRate = annualRate / 100 / 12;
  const limit = maxMonths ?? MAX_LOAN_MONTHS;
  const schedule = [];
  let bal = balance;
  let cumulInterest = 0;
  let prevContrib = baseContrib;

  for (let n = 1; n <= limit; n++) {
    if (bal <= 0.005) break;

    const startBal    = bal;
    const inRepayment = n > DRAW_MONTHS;

    // ── Transaction 1: Regular housing payment on full startBal ──
    const interest = round2(startBal * monthlyRate);
    const minPmt   = round2(startBal * minPctPerMonth / 100);
    const addl = housingTarget > 0
      ? Math.max(0, round2(housingTarget - (fixedObligation || 0) - minPmt))
      : round2(getContribForMonth(baseContrib || 0, contribRules || [], n));

    let totalPmt = minPmt + addl;
    const maxPmt = round2(startBal + interest);
    if (totalPmt > maxPmt) totalPmt = round2(maxPmt);

    const principal   = round2(totalPmt - interest);
    const balAfterPmt = Math.max(0, round2(startBal - principal));

    // ── Transaction 2: Lump sum — independent direct principal reduction ──
    const scheduledLS = round2(getLumpSumForMonth(lsRules       || [], n, startDateStr));
    const solverLS    = round2(getLumpSumForMonth(solverLsRules || [], n, startDateStr));
    const lumpSum     = round2(scheduledLS + solverLS);

    const endBal = Math.max(0, round2(balAfterPmt - lumpSum));
    cumulInterest = round2(cumulInterest + interest);

    const contribChanged = (n > 1 && addl !== prevContrib);
    prevContrib = addl;

    schedule.push({
      monthNum: n,
      date: monthNumToDate(startDateStr, n),
      startBal, minPmt, addlContrib: addl,
      scheduledLumpSum: scheduledLS, solverLumpSum: solverLS, lumpSum,
      totalPmt, principal, interest, endBal, cumulInterest,
      contribChanged,
      hasScheduledLS: scheduledLS > 0,
      hasSolverLS:    solverLS    > 0,
      hasLumpSum:     lumpSum     > 0,
      period: inRepayment ? 'repayment' : 'draw',
    });

    bal = endBal;
    if (bal <= 0.005) break;
  }
  return schedule;
}

const fmt  = v => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pass = (cond, msg) => console.log(`  ${cond ? 'PASS ✓' : 'FAIL ✗'} ${msg}`);

// ─────────────────────────────────────────────────────────────────
// PARAMETERS
// ─────────────────────────────────────────────────────────────────
const START = '2026-04-01';   // April 2026 = month 1
// June 2026 = month 3 (Apr=1, May=2, Jun=3)
const JUNE_2026_MONTH = calendarMonthToLoanMonth(START, 2026, 6);  // = 3

const BASE = {
  balance:        250000,
  annualRate:     8.75,
  minPctPerMonth: 1,
  baseContrib:    0,
  contribRules:   [],
  solverLsRules:  [],
  lsRules:        [],
  startDateStr:   START,
  housingTarget:  6250,
  fixedObligation: 2307,
};

// ─────────────────────────────────────────────────────────────────
// BASELINE
// ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('BASELINE: $250k, 8.75%, 1% min, $6,250 housing target, $2,307 fixed');
console.log('══════════════════════════════════════════════');

const baseline = runAmortization(BASE);
const baseInterest   = baseline[baseline.length - 1].cumulInterest;
const basePayoffMo   = baseline.length;
const basePayoffDate = baseline[baseline.length - 1].date;
const baseM5Open     = baseline[4].startBal;   // month 5 startBal = month 4 endBal

console.log(`  Total interest:          ${fmt(baseInterest)}`);
console.log(`  Payoff:                  month ${basePayoffMo} (${basePayoffDate})`);
console.log(`  Month 5 opening balance: ${fmt(baseM5Open)}`);
console.log(`  (June 2026 = loan month ${JUNE_2026_MONTH})`);

// Show first 5 months for reference
console.log('\n  Months 1-5:');
for (let i = 0; i < 5; i++) {
  const r = baseline[i];
  console.log(`    Month ${r.monthNum} (${r.date}): startBal=${fmt(r.startBal)}, interest=${fmt(r.interest)}, minPmt=${fmt(r.minPmt)}, addl=${fmt(r.addlContrib)}, totalPmt=${fmt(r.totalPmt)}, endBal=${fmt(r.endBal)}`);
}

// ─────────────────────────────────────────────────────────────────
// TEST 1 — One-time $10,000 in June 2026 (loan month 3)
// ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('TEST 1: One-time $10,000 lump sum in June 2026 (loan month 3)');
console.log('══════════════════════════════════════════════');

const t1 = runAmortization({
  ...BASE,
  lsRules: [{ cadence: 'once', startMonth: JUNE_2026_MONTH, amount: 10000 }],
});

const t1Interest = t1[t1.length - 1].cumulInterest;
const t1M5Open   = t1[4].startBal;
const t1Saved    = round2(baseInterest - t1Interest);

console.log(`  Month 5 opening balance: ${fmt(t1M5Open)}  (baseline: ${fmt(baseM5Open)}, diff: ${fmt(round2(baseM5Open - t1M5Open))})`);
console.log(`  Total interest:          ${fmt(t1Interest)}  (baseline: ${fmt(baseInterest)})`);
console.log(`  Interest saved:          ${fmt(t1Saved)}`);
pass(t1Saved > 3000, `Interest saved ${fmt(t1Saved)} > $3,000`);

// Show month 3 detail
const m3_base = baseline[2];
const m3_t1   = t1[2];
console.log('\n  Month 3 (June 2026) detail:');
console.log(`    Baseline:  startBal=${fmt(m3_base.startBal)}, totalPmt=${fmt(m3_base.totalPmt)}, lumpSum=$0.00, endBal=${fmt(m3_base.endBal)}`);
console.log(`    With LS:   startBal=${fmt(m3_t1.startBal)},  totalPmt=${fmt(m3_t1.totalPmt)}, lumpSum=${fmt(m3_t1.lumpSum)}, endBal=${fmt(m3_t1.endBal)}`);
console.log(`    Lump sum reduced endBal by: ${fmt(round2(m3_base.endBal - m3_t1.endBal))} (must be exactly $10,000)`);
pass(Math.abs(round2(m3_base.endBal - m3_t1.endBal) - 10000) < 0.01, 'Month 3 endBal reduced by exactly $10,000');

// ─────────────────────────────────────────────────────────────────
// TEST 2 — Annual $10,000 starting June 2026 (loan month 3)
// ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('TEST 2: Annual $10,000 lump sum starting June 2026 (loan month 3)');
console.log('══════════════════════════════════════════════');

const t2 = runAmortization({
  ...BASE,
  lsRules: [{ cadence: 'annually', startMonth: JUNE_2026_MONTH, amount: 10000 }],
});

const t2Interest   = t2[t2.length - 1].cumulInterest;
const t2PayoffMo   = t2.length;
const t2PayoffDate = t2[t2.length - 1].date;
const t2Saved      = round2(baseInterest - t2Interest);

console.log(`  Total interest:  ${fmt(t2Interest)}  (baseline: ${fmt(baseInterest)})`);
console.log(`  Interest saved:  ${fmt(t2Saved)}`);
console.log(`  Payoff:          month ${t2PayoffMo} (${t2PayoffDate})  (baseline: month ${basePayoffMo}, ${basePayoffDate})`);
console.log(`  Months saved:    ${basePayoffMo - t2PayoffMo}`);
pass(t2Saved > 5000, `Interest saved ${fmt(t2Saved)} > $5,000`);
pass(t2PayoffMo < basePayoffMo, `Payoff month ${t2PayoffMo} < baseline ${basePayoffMo}`);

// First few lump sum months
console.log('\n  First 3 lump sum months:');
t2.filter(r => r.lumpSum > 0).slice(0, 3).forEach(r => {
  console.log(`    Month ${r.monthNum} (${r.date}): startBal=${fmt(r.startBal)}, totalPmt=${fmt(r.totalPmt)}, lumpSum=${fmt(r.lumpSum)}, endBal=${fmt(r.endBal)}`);
});

// ─────────────────────────────────────────────────────────────────
// TEST 3 — Both rules simultaneously
// ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('TEST 3: Both rules simultaneously (one-time June 2026 + annual from June 2026)');
console.log('══════════════════════════════════════════════');

const t3 = runAmortization({
  ...BASE,
  lsRules: [
    { cadence: 'once',     startMonth: JUNE_2026_MONTH, amount: 10000 },
    { cadence: 'annually', startMonth: JUNE_2026_MONTH, amount: 10000 },
  ],
});

const t3Interest   = t3[t3.length - 1].cumulInterest;
const t3PayoffMo   = t3.length;
const t3PayoffDate = t3[t3.length - 1].date;
const t3Saved      = round2(baseInterest - t3Interest);

console.log(`  Total interest:     ${fmt(t3Interest)}`);
console.log(`  Interest saved:     ${fmt(t3Saved)}  vs baseline`);
console.log(`  vs Test 1:          ${fmt(round2(t1Interest - t3Interest))} additional savings`);
console.log(`  vs Test 2:          ${fmt(round2(t2Interest - t3Interest))} additional savings`);
console.log(`  Payoff:             month ${t3PayoffMo} (${t3PayoffDate})`);
pass(t3Interest < t1Interest, `Test 3 interest ${fmt(t3Interest)} < Test 1 ${fmt(t1Interest)}`);
pass(t3Interest < t2Interest, `Test 3 interest ${fmt(t3Interest)} < Test 2 ${fmt(t2Interest)}`);
pass(t3Interest < baseInterest, `Test 3 interest ${fmt(t3Interest)} < baseline ${fmt(baseInterest)}`);

// Month 3 with both rules — should fire $20,000 total (once + annual both hit month 3)
const m3_t3 = t3[2];
console.log(`\n  Month 3 (June 2026): totalPmt=${fmt(m3_t3.totalPmt)}, lumpSum=${fmt(m3_t3.lumpSum)} (once $10k + annual $10k = $20k)`);
pass(Math.abs(m3_t3.lumpSum - 20000) < 0.01, 'Month 3 lump sum = $20,000 (both rules fire)');

console.log('\n══════════════════════════════════════════════');
console.log('ARCHITECTURAL VERIFICATION');
console.log('══════════════════════════════════════════════');
// Verify: in any lump sum month, totalPmt is the same as baseline (payment unaffected)
const lsMonth = t1.find(r => r.lumpSum > 0);
const baseMonth = baseline.find(r => r.monthNum === lsMonth.monthNum);
console.log(`  Lump sum month ${lsMonth.monthNum}: t1.totalPmt=${fmt(lsMonth.totalPmt)}, baseline.totalPmt=${fmt(baseMonth.totalPmt)}`);
pass(Math.abs(lsMonth.totalPmt - baseMonth.totalPmt) < 0.01, 'Housing payment unchanged in lump sum month');
pass(lsMonth.interest === baseMonth.interest, `Interest unchanged in lump sum month (${fmt(lsMonth.interest)} = ${fmt(baseMonth.interest)})`);
