#!/usr/bin/env node
// Validation tests — rebuilt lump sum engine with Month Name + Year data model

const round2 = v => Math.round(v * 100) / 100;
const DRAW_MONTHS     = 240;
const MAX_LOAN_MONTHS = 480;

const LS_MON_NAMES = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];

function monthStrToLoanMonth(monthStr, startDateStr) {
  if (!monthStr) return null;
  const parts    = monthStr.trim().split(' ');
  const calMonth = LS_MON_NAMES.indexOf(parts[0]) + 1;
  const calYear  = parseInt(parts[1], 10);
  if (calMonth < 1 || isNaN(calYear)) return null;
  const [sy, sm] = startDateStr.split('-').map(Number);
  return (calYear - sy) * 12 + (calMonth - sm) + 1;
}

function getLumpSumForMonth(lsRules, monthNum, startDateStr) {
  let total = 0;
  for (const r of lsRules) {
    const s = r.startMonthStr
      ? monthStrToLoanMonth(r.startMonthStr, startDateStr)
      : (r.startMonth || 1);
    if (s === null || monthNum < s) continue;

    const e = r.endMonthStr ? monthStrToLoanMonth(r.endMonthStr, startDateStr) : null;
    if (e !== null && monthNum > e) continue;

    switch (r.cadence) {
      case 'once':       if (monthNum === s) total += r.amount; break;
      case 'monthly':    total += r.amount; break;
      case 'annually':   if ((monthNum - s) % 12 === 0) total += r.amount; break;
      case 'biannually': if ((monthNum - s) % 6  === 0) total += r.amount; break;
      case 'quarterly':  if ((monthNum - s) % 3  === 0) total += r.amount; break;
      case 'custom':     if (r.interval > 0 && (monthNum - s) % r.interval === 0) total += r.amount; break;
    }
  }
  return total;
}

function getContribForMonth(baseContrib, changeRules, monthNum) {
  let amount = baseContrib;
  for (const r of changeRules) {
    if (r.startMonth <= monthNum) amount = r.amount; else break;
  }
  return amount;
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
  let bal = balance, cumulInterest = 0, prevContrib = baseContrib;

  for (let n = 1; n <= limit; n++) {
    if (bal <= 0.005) break;

    const startBal    = bal;
    const inRepayment = n > DRAW_MONTHS;

    // Transaction 1: regular housing payment on full startBal
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

    // Transaction 2: lump sum — independent direct principal reduction
    const scheduledLS = round2(getLumpSumForMonth(lsRules       || [], n, startDateStr));
    const solverLS    = round2(getLumpSumForMonth(solverLsRules || [], n, startDateStr));
    const lumpSum     = round2(scheduledLS + solverLS);

    const endBal = Math.max(0, round2(balAfterPmt - lumpSum));
    cumulInterest = round2(cumulInterest + interest);

    schedule.push({
      monthNum: n, date: monthNumToDate(startDateStr, n),
      startBal, minPmt, addlContrib: addl, lumpSum,
      totalPmt, principal, interest, endBal, cumulInterest,
      scheduledLumpSum: scheduledLS, solverLumpSum: solverLS,
    });

    bal = endBal;
    if (bal <= 0.005) break;
  }
  return schedule;
}

const fmt  = v => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pass = (cond, msg) => console.log(`  ${cond ? 'PASS ✓' : 'FAIL ✗'} ${msg}`);

// ─────────────────────────────────────────────────────────────────
// PARAMETERS (start April 2026; June 2026 = loan month 3)
// ─────────────────────────────────────────────────────────────────
const START = '2026-04-01';
const BASE  = {
  balance: 250000, annualRate: 8.75, minPctPerMonth: 1,
  baseContrib: 0, contribRules: [], solverLsRules: [], lsRules: [],
  startDateStr: START, housingTarget: 6250, fixedObligation: 2307,
};

// Verify month mapping
const juneMonth = monthStrToLoanMonth('June 2026', START);
console.log(`\nMonth mapping: June 2026 = loan month ${juneMonth} (expected 3)`);
pass(juneMonth === 3, 'June 2026 maps to loan month 3');

// ─────────────────────────────────────────────────────────────────
// BASELINE
// ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('BASELINE: $250k · 8.75% · 1% min · $6,250 housing · $2,307 fixed · no lump sums');
console.log('══════════════════════════════════════════════');

const baseline    = runAmortization(BASE);
const baseInterest   = baseline[baseline.length - 1].cumulInterest;
const basePayoffMo   = baseline.length;
const basePayoffDate = baseline[baseline.length - 1].date;
const baseM5Open     = baseline[4].startBal;

console.log(`  Total interest:          ${fmt(baseInterest)}`);
console.log(`  Payoff:                  month ${basePayoffMo} (${basePayoffDate})`);
console.log(`  Month 5 opening balance: ${fmt(baseM5Open)}`);

// ─────────────────────────────────────────────────────────────────
// TEST 1 — One-Time $10,000 in June 2026
// ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('TEST 1: One-Time $10,000 — June 2026');
console.log('══════════════════════════════════════════════');

const t1 = runAmortization({
  ...BASE,
  lsRules: [{ amount: 10000, cadence: 'once', startMonthStr: 'June 2026', endMonthStr: '' }],
});

const t1Interest = t1[t1.length - 1].cumulInterest;
const t1M5Open   = t1[4].startBal;
const t1Saved    = round2(baseInterest - t1Interest);

console.log(`  Month 5 opening balance: ${fmt(t1M5Open)}  (baseline: ${fmt(baseM5Open)}, Δ = ${fmt(round2(baseM5Open - t1M5Open))})`);
console.log(`  Total interest:          ${fmt(t1Interest)}  (baseline: ${fmt(baseInterest)})`);
console.log(`  Interest saved:          ${fmt(t1Saved)}`);
pass(t1Saved > 3000, `Interest saved ${fmt(t1Saved)} > $3,000`);

// Verify $10k exact reduction in month 3 closing balance
const m3Base = baseline[2];
const m3T1   = t1[2];
const m3Reduction = round2(m3Base.endBal - m3T1.endBal);
console.log(`\n  Month 3 (June 2026): baseline endBal=${fmt(m3Base.endBal)}, with LS endBal=${fmt(m3T1.endBal)}`);
console.log(`  Lump sum reduced month 3 closing balance by: ${fmt(m3Reduction)}`);
console.log(`  Housing payment: baseline=${fmt(m3Base.totalPmt)}, with LS=${fmt(m3T1.totalPmt)} (must be equal)`);
console.log(`  Interest:        baseline=${fmt(m3Base.interest)}, with LS=${fmt(m3T1.interest)} (must be equal)`);
pass(Math.abs(m3Reduction - 10000) < 0.01, 'Month 3 balance reduced by exactly $10,000');
pass(Math.abs(m3T1.totalPmt - m3Base.totalPmt) < 0.01, 'Housing payment unchanged in lump sum month');
pass(Math.abs(m3T1.interest - m3Base.interest) < 0.01, 'Interest unchanged in lump sum month');

// ─────────────────────────────────────────────────────────────────
// TEST 2 — Annual $10,000 starting June 2026
// ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('TEST 2: Annually $10,000 starting June 2026');
console.log('══════════════════════════════════════════════');

const t2 = runAmortization({
  ...BASE,
  lsRules: [{ amount: 10000, cadence: 'annually', startMonthStr: 'June 2026', endMonthStr: '' }],
});

const t2Interest   = t2[t2.length - 1].cumulInterest;
const t2PayoffMo   = t2.length;
const t2PayoffDate = t2[t2.length - 1].date;
const t2Saved      = round2(baseInterest - t2Interest);

console.log(`  Total interest:  ${fmt(t2Interest)}  (baseline: ${fmt(baseInterest)})`);
console.log(`  Interest saved:  ${fmt(t2Saved)}`);
console.log(`  Payoff:          month ${t2PayoffMo} (${t2PayoffDate})  baseline: month ${basePayoffMo} (${basePayoffDate})`);
console.log(`  Months saved:    ${basePayoffMo - t2PayoffMo}`);
pass(t2Saved > 5000, `Interest saved ${fmt(t2Saved)} > $5,000`);
pass(t2PayoffMo < basePayoffMo, `Payoff month ${t2PayoffMo} earlier than baseline ${basePayoffMo}`);

// Show lump sum fire months (should be months 3, 15, 27 …)
const lsMonths = t2.filter(r => r.lumpSum > 0).slice(0, 3);
console.log('\n  First 3 lump sum months:');
lsMonths.forEach(r => {
  console.log(`    Month ${r.monthNum} (${r.date}): housePmt=${fmt(r.totalPmt)}, LS=${fmt(r.lumpSum)}, endBal=${fmt(r.endBal)}`);
});
pass(lsMonths[0].monthNum === 3,  'First LS fires at loan month 3 (June 2026)');
pass(lsMonths[1].monthNum === 15, 'Second LS fires at loan month 15 (June 2027)');

// ─────────────────────────────────────────────────────────────────
// TEST 3 — Both rules simultaneously
// ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('TEST 3: Both rules — One-Time June 2026 AND Annual from June 2026');
console.log('══════════════════════════════════════════════');

const t3 = runAmortization({
  ...BASE,
  lsRules: [
    { amount: 10000, cadence: 'once',     startMonthStr: 'June 2026', endMonthStr: '' },
    { amount: 10000, cadence: 'annually', startMonthStr: 'June 2026', endMonthStr: '' },
  ],
});

const t3Interest   = t3[t3.length - 1].cumulInterest;
const t3PayoffMo   = t3.length;
const t3PayoffDate = t3[t3.length - 1].date;
const t3Saved      = round2(baseInterest - t3Interest);

console.log(`  Total interest:  ${fmt(t3Interest)}`);
console.log(`  Interest saved:  ${fmt(t3Saved)}  vs baseline`);
console.log(`  vs Test 1:       ${fmt(round2(t1Interest - t3Interest))} additional`);
console.log(`  vs Test 2:       ${fmt(round2(t2Interest - t3Interest))} additional`);
console.log(`  Payoff:          month ${t3PayoffMo} (${t3PayoffDate})`);
pass(t3Interest < t1Interest, `Test 3 interest ${fmt(t3Interest)} < Test 1 ${fmt(t1Interest)}`);
pass(t3Interest < t2Interest, `Test 3 interest ${fmt(t3Interest)} < Test 2 ${fmt(t2Interest)}`);
pass(t3Interest < baseInterest, `Test 3 interest ${fmt(t3Interest)} < baseline ${fmt(baseInterest)}`);

const m3T3 = t3[2];
console.log(`\n  Month 3 lump sum: ${fmt(m3T3.lumpSum)} (one-time $10k + annual $10k = $20k expected)`);
pass(Math.abs(m3T3.lumpSum - 20000) < 0.01, 'Month 3 fires $20,000 (both rules additive)');

// ─────────────────────────────────────────────────────────────────
// END MONTH TEST — Annual with end month
// ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('END MONTH TEST: Annual $10k June 2026 → June 2028 (3 payments only)');
console.log('══════════════════════════════════════════════');

const tEnd = runAmortization({
  ...BASE,
  lsRules: [{ amount: 10000, cadence: 'annually', startMonthStr: 'June 2026', endMonthStr: 'June 2028' }],
});
const endLsMonths = tEnd.filter(r => r.lumpSum > 0);
console.log(`  Lump sum fires: ${endLsMonths.length} times (months: ${endLsMonths.map(r=>r.monthNum).join(', ')})`);
console.log(`  Expected: months 3, 15, 27`);
pass(endLsMonths.length === 3, '3 lump sums fired (June 2026, June 2027, June 2028)');
pass(endLsMonths[endLsMonths.length-1].monthNum === 27, 'Last LS fires at month 27 (June 2028)');

console.log('\n══════════════════════════════════════════════');
