#!/usr/bin/env node
// Validation tests for rebuilt lump sum engine (apply-before-interest model)

const round2 = v => Math.round(v * 100) / 100;
const DRAW_MONTHS = 240;
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

// NEW ENGINE: lump sum applied BEFORE interest calculation
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

    const startBal = bal;

    // Step 1: Get lump sums for this month
    const scheduledLS = round2(getLumpSumForMonth(lsRules       || [], n, startDateStr));
    const solverLS    = round2(getLumpSumForMonth(solverLsRules || [], n, startDateStr));
    const lumpSum     = round2(scheduledLS + solverLS);

    // Step 2: Apply lump sum as immediate principal reduction before interest
    const balAfterLS  = Math.max(0, round2(startBal - lumpSum));
    const inRepayment = n > DRAW_MONTHS;

    // Step 3: All calculations on reduced balance
    const interest = round2(balAfterLS * monthlyRate);
    const minPmt   = round2(balAfterLS * minPctPerMonth / 100);

    const addl = housingTarget > 0
      ? Math.max(0, round2(housingTarget - (fixedObligation || 0) - minPmt))
      : round2(getContribForMonth(baseContrib || 0, contribRules || [], n));

    let totalPmt = minPmt + addl;
    const maxPmt = round2(balAfterLS + interest);
    if (totalPmt > maxPmt) totalPmt = round2(maxPmt);

    const principal = round2(totalPmt - interest);
    const endBal    = Math.max(0, round2(balAfterLS - principal));
    cumulInterest   = round2(cumulInterest + interest);

    const contribChanged = (n > 1 && addl !== prevContrib);
    prevContrib = addl;

    schedule.push({
      monthNum: n, startBal, lumpSum, balAfterLS,
      minPmt, addlContrib: addl, totalPmt, principal,
      interest, endBal, cumulInterest,
      scheduledLumpSum: scheduledLS, solverLumpSum: solverLS,
    });

    bal = endBal;
    if (bal <= 0.005) break;
  }
  return schedule;
}

const fmt = v => `$${v.toFixed(2)}`;

// ──────────────────────────────────────────────
// TEST PARAMS
// ──────────────────────────────────────────────
const BASE = {
  balance: 100000,
  annualRate: 8.75,
  minPctPerMonth: 1,
  baseContrib: 0,
  contribRules: [],
  solverLsRules: [],
  startDateStr: '2026-04-01',
};

// ──────────────────────────────────────────────
// VALIDATION TEST 1: Annual $10k from month 4 saves > $5,000 vs. baseline
// ──────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('VALIDATION TEST 1: Annual $10k lump sum from month 4');
console.log('══════════════════════════════════════════════');

const baseSchedule = runAmortization({ ...BASE, lsRules: [] });
const lsSchedule   = runAmortization({ ...BASE, lsRules: [{ cadence: 'annually', startMonth: 4, amount: 10000 }] });

const baseInterest = baseSchedule[baseSchedule.length - 1].cumulInterest;
const lsInterest   = lsSchedule[lsSchedule.length - 1].cumulInterest;
const interestSaved = round2(baseInterest - lsInterest);

console.log(`Baseline total interest:     ${fmt(baseInterest)}`);
console.log(`With annual $10k LS:         ${fmt(lsInterest)}`);
console.log(`Interest saved:              ${fmt(interestSaved)}`);
console.log(`Baseline payoff:             ${baseSchedule.length} months`);
console.log(`With LS payoff:              ${lsSchedule.length} months`);
console.log(`PASS: Interest saved > $5,000? ${interestSaved > 5000 ? 'YES ✓' : 'NO ✗'}`);

// Show lump sum rows
const lsRows = lsSchedule.filter(r => r.lumpSum > 0).slice(0, 5);
console.log('\nFirst 5 lump sum months:');
lsRows.forEach(r => {
  console.log(`  Month ${r.monthNum}: startBal=${fmt(r.startBal)}, LS=${fmt(r.lumpSum)}, balAfterLS=${fmt(r.balAfterLS)}, interest=${fmt(r.interest)} (on reduced bal), endBal=${fmt(r.endBal)}`);
});

// ──────────────────────────────────────────────
// VALIDATION TEST 2: One-time $10k at month 4 → month 5 opening balance
// ──────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log('VALIDATION TEST 2: One-time $10k at month 4 → month 5 balance reduction');
console.log('══════════════════════════════════════════════');

const noLS   = runAmortization({ ...BASE, lsRules: [] });
const oneOff = runAmortization({ ...BASE, lsRules: [{ cadence: 'once', startMonth: 4, amount: 10000 }] });

// Month 4 rows (index 3)
const m4_noLS   = noLS[3];
const m4_oneOff = oneOff[3];
// Month 5 opening balance = month 4 endBal
const m5_open_noLS   = m4_noLS.endBal;
const m5_open_oneOff = m4_oneOff.endBal;
const balReduction = round2(m5_open_noLS - m5_open_oneOff);

console.log('\nMonth 4 — NO lump sum:');
console.log(`  startBal=${fmt(m4_noLS.startBal)}, interest=${fmt(m4_noLS.interest)}, minPmt=${fmt(m4_noLS.minPmt)}, endBal=${fmt(m4_noLS.endBal)}`);

console.log('\nMonth 4 — WITH $10,000 lump sum (applied BEFORE interest):');
console.log(`  startBal=${fmt(m4_oneOff.startBal)}, lumpSum=${fmt(m4_oneOff.lumpSum)}, balAfterLS=${fmt(m4_oneOff.balAfterLS)}`);
console.log(`  interest=${fmt(m4_oneOff.interest)} (on balAfterLS), minPmt=${fmt(m4_oneOff.minPmt)}, endBal=${fmt(m4_oneOff.endBal)}`);

console.log(`\nMonth 5 opening balance (no LS):   ${fmt(m5_open_noLS)}`);
console.log(`Month 5 opening balance (with LS): ${fmt(m5_open_oneOff)}`);
console.log(`Balance reduction:                 ${fmt(balReduction)}`);

console.log('\n--- Mathematical note ---');
console.log(`Expected with "apply-before-interest" model: 10000 * (0.99 + 8.75%/12) = ${fmt(10000 * (0.99 + 0.0875/12))}`);
console.log(`Expected with "lumpSum-in-totalPmt" model:   exactly $10,000.00`);
console.log(`\nWith the "apply before interest" model, the reduction is NOT exactly $10,000.`);
console.log(`The interest calculation on the reduced balance lowers the minPmt too,`);
console.log(`so the net reduction is 10000 × (1 − minPct/100 + rate/12) = 10000 × (0.99 + rate)`);
console.log(`= ${fmt(balReduction)} rather than $10,000.00`);
console.log(`\nThis is mathematically correct behavior for "apply before interest" semantics.`);
console.log(`The user's validation criterion of "exactly $10,000" is only achievable`);
console.log(`with the lumpSum-in-totalPmt model.`);
