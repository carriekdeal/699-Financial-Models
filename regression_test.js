#!/usr/bin/env node
// Regression test — exact mirror of heloc-payoff-model.html engine + solver

const round2 = v => Math.round(v * 100) / 100;
const DRAW_MONTHS     = 240;
const MAX_LOAN_MONTHS = 480;
const LS_MON_NAMES    = ['January','February','March','April','May','June',
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
      case 'once':       if (monthNum === s)                              total += r.amount; break;
      case 'monthly':    total += r.amount; break;
      case 'annually':   if ((monthNum - s) % 12 === 0)                  total += r.amount; break;
      case 'biannually': if ((monthNum - s) % 6  === 0)                  total += r.amount; break;
      case 'quarterly':  if ((monthNum - s) % 3  === 0)                  total += r.amount; break;
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
    const startBal = bal;
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
    const scheduledLS = round2(getLumpSumForMonth(lsRules       || [], n, startDateStr));
    const solverLS    = round2(getLumpSumForMonth(solverLsRules || [], n, startDateStr));
    const lumpSum     = round2(scheduledLS + solverLS);
    const endBal      = Math.max(0, round2(balAfterPmt - lumpSum));
    cumulInterest     = round2(cumulInterest + interest);
    schedule.push({ monthNum: n, startBal, minPmt, addlContrib: addl,
                    scheduledLumpSum: scheduledLS, solverLumpSum: solverLS,
                    lumpSum, totalPmt, principal, interest, endBal, cumulInterest });
    bal = endBal;
    if (bal <= 0.005) break;
  }
  return schedule;
}

function bisect(fn, lo, hi, target, tol, maxIter) {
  tol     = tol     ?? 0.01;
  maxIter = maxIter ?? 200;
  let a = lo, b = hi;
  let fa = fn(a) - target;
  let fb = fn(b) - target;
  if (fa <= 0 && Math.abs(fa) <= tol) return { found: true, value: a };
  if (fb <= 0 && Math.abs(fb) <= tol) return { found: true, value: b };
  if (fa * fb > 0) return { found: false, value: null };
  for (let i = 0; i < maxIter; i++) {
    const mid = (a + b) / 2;
    const fm  = fn(mid) - target;
    if ((b - a) < 1e-10) return { found: true, value: mid };
    if (fm <= 0 && Math.abs(fm) <= tol) return { found: true, value: mid };
    if (fa * fm <= 0) { b = mid; fb = fm; }
    else              { a = mid; fa = fm; }
  }
  return { found: true, value: (a + b) / 2 };
}

// Solve for targetHousingPmt to hit payoffMonths target.
// Lump sums are stripped from objFn (they are independent of housing target).
// Final schedule runs with lsRules applied on top of solved housing target.
function solveHousingTarget(baseParams, targetMonths, lsRules) {
  const objFn = x => {
    const s = runAmortization({ ...baseParams, housingTarget: x, lsRules: [], solverLsRules: [] });
    return s.length;
  };
  const lo = 0, hi = baseParams.balance * 20, tol = 0.5;
  const result = bisect(objFn, lo, hi, targetMonths, tol, 200);
  const solvedHousing = result.value;
  // Final schedule uses solved housing target + scheduled lump sums
  const schedule = runAmortization({ ...baseParams, housingTarget: solvedHousing, lsRules, solverLsRules: [] });
  return { solvedHousing, schedule };
}

const fmt = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pass = (cond, msg) => { console.log(`  ${cond ? 'PASS ✓' : 'FAIL ✗'} ${msg}`); return cond; };

// ─── SETUP ────────────────────────────────────────────────────────────────────
const START_DATE      = '2026-10-01';
const BALANCE         = 250000;
const ANNUAL_RATE     = 8.75;
const MIN_PCT         = 1;
const FIXED_OBL       = 2307;
const TARGET_MONTHS   = 51;  // December 1 2030

const baseParams = {
  balance: BALANCE, annualRate: ANNUAL_RATE, minPctPerMonth: MIN_PCT,
  fixedObligation: FIXED_OBL, baseContrib: 0, contribRules: [],
  solverLsRules: [], startDateStr: START_DATE,
};

// ─── BASELINE ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log('BASELINE: $250k · 8.75% · 1% min · $2,307 fixed · payoff locked 51 months · no lump sums');
console.log('══════════════════════════════════════════════════════════');

const { solvedHousing: baseHousing, schedule: baseSched } =
  solveHousingTarget(baseParams, TARGET_MONTHS, []);

const baseTotalInterest = baseSched[baseSched.length - 1].cumulInterest;
const baseTotalPaid     = round2(baseSched.reduce((s, r) => s + r.totalPmt + r.lumpSum, 0));
const basePayoffMonths  = baseSched.length;

console.log(`  Target Monthly Housing Payment : ${fmt(baseHousing)}`);
console.log(`  Total Interest                 : ${fmt(baseTotalInterest)}`);
console.log(`  Total Paid                     : ${fmt(baseTotalPaid)}`);
console.log(`  Payoff months                  : ${basePayoffMonths}`);
console.log(`  Month 1 addlContrib            : ${fmt(baseSched[0].addlContrib)}`);

// ─── TEST 1 — Annual $10k from February 2027 ──────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log('TEST 1: + Annual $10,000 starting February 2027');
console.log('══════════════════════════════════════════════════════════');

const t1Rules = [{ amount: 10000, cadence: 'annually', startMonthStr: 'February 2027', endMonthStr: '' }];
const { solvedHousing: t1Housing, schedule: t1Sched } =
  solveHousingTarget(baseParams, TARGET_MONTHS, t1Rules);

const t1TotalInterest = t1Sched[t1Sched.length - 1].cumulInterest;
const t1TotalPaid     = round2(t1Sched.reduce((s, r) => s + r.totalPmt + r.lumpSum, 0));
const t1PayoffMonths  = t1Sched.length;
const t1InterestDelta = round2(baseTotalInterest - t1TotalInterest);

// Verify Feb 2027 = loan month 5 and check it fires
const feb2027Month = monthStrToLoanMonth('February 2027', START_DATE);
const lsFireMonths = t1Sched.filter(r => r.lumpSum > 0).map(r => r.monthNum);

console.log(`  Target Monthly Housing Payment : ${fmt(t1Housing)}`);
console.log(`  Total Interest                 : ${fmt(t1TotalInterest)}`);
console.log(`  Total Paid                     : ${fmt(t1TotalPaid)}`);
console.log(`  Payoff months                  : ${t1PayoffMonths}`);
console.log(`  Interest saved vs baseline     : ${fmt(t1InterestDelta)}`);
console.log(`  Feb 2027 = loan month          : ${feb2027Month}`);
console.log(`  Lump sum fires at months       : ${lsFireMonths.join(', ')}`);

pass(Math.abs(t1Housing - baseHousing) < 0.01,
  `Housing target IDENTICAL to baseline (${fmt(t1Housing)} vs ${fmt(baseHousing)})`);
pass(t1InterestDelta >= 8000,
  `Interest saved ${fmt(t1InterestDelta)} ≥ $8,000`);
pass(t1TotalPaid < baseTotalPaid,
  `Total Paid ${fmt(t1TotalPaid)} < baseline ${fmt(baseTotalPaid)}`);
pass(t1PayoffMonths <= TARGET_MONTHS,
  `Payoff months ${t1PayoffMonths} ≤ ${TARGET_MONTHS}`);

// ─── TEST 2 — Remove rule, back to baseline ────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log('TEST 2: Remove rule — must return to exact baseline values');
console.log('══════════════════════════════════════════════════════════');

const { solvedHousing: t2Housing, schedule: t2Sched } =
  solveHousingTarget(baseParams, TARGET_MONTHS, []);

const t2TotalInterest = t2Sched[t2Sched.length - 1].cumulInterest;
const t2TotalPaid     = round2(t2Sched.reduce((s, r) => s + r.totalPmt + r.lumpSum, 0));
const t2PayoffMonths  = t2Sched.length;

console.log(`  Target Monthly Housing Payment : ${fmt(t2Housing)}  (baseline: ${fmt(baseHousing)})`);
console.log(`  Total Interest                 : ${fmt(t2TotalInterest)}  (baseline: ${fmt(baseTotalInterest)})`);
console.log(`  Total Paid                     : ${fmt(t2TotalPaid)}  (baseline: ${fmt(baseTotalPaid)})`);
console.log(`  Payoff months                  : ${t2PayoffMonths}  (baseline: ${basePayoffMonths})`);

pass(Math.abs(t2Housing       - baseHousing)        < 0.01, `Housing target matches baseline exactly`);
pass(Math.abs(t2TotalInterest - baseTotalInterest)  < 0.01, `Total Interest matches baseline exactly`);
pass(Math.abs(t2TotalPaid     - baseTotalPaid)      < 0.01, `Total Paid matches baseline exactly`);
pass(t2PayoffMonths === basePayoffMonths,                    `Payoff months matches baseline exactly`);

// ─── TEST 3 — Two simultaneous rules ──────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log('TEST 3: Rule 1: One-Time $25,000 June 2027  +  Rule 2: Annually $5,000 from January 2028');
console.log('══════════════════════════════════════════════════════════');

const t3Rules = [
  { amount: 25000, cadence: 'once',     startMonthStr: 'June 2027',    endMonthStr: '' },
  { amount:  5000, cadence: 'annually', startMonthStr: 'January 2028', endMonthStr: '' },
];
const { solvedHousing: t3Housing, schedule: t3Sched } =
  solveHousingTarget(baseParams, TARGET_MONTHS, t3Rules);

const t3TotalInterest = t3Sched[t3Sched.length - 1].cumulInterest;
const t3TotalPaid     = round2(t3Sched.reduce((s, r) => s + r.totalPmt + r.lumpSum, 0));
const t3PayoffMonths  = t3Sched.length;

// Check specific months
const june2027Month = monthStrToLoanMonth('June 2027',    START_DATE);  // expect month 9
const jan2028Month  = monthStrToLoanMonth('January 2028', START_DATE);  // expect month 16

const jun27Row = t3Sched.find(r => r.monthNum === june2027Month);
const jan28Row = t3Sched.find(r => r.monthNum === jan2028Month);
const t3LsFireMonths = t3Sched.filter(r => r.lumpSum > 0).map(r => `${r.monthNum}(${fmt(r.lumpSum)})`);

console.log(`  Target Monthly Housing Payment : ${fmt(t3Housing)}`);
console.log(`  Total Interest                 : ${fmt(t3TotalInterest)}`);
console.log(`  Total Paid                     : ${fmt(t3TotalPaid)}`);
console.log(`  Payoff months                  : ${t3PayoffMonths}`);
console.log(`  June 2027 = loan month         : ${june2027Month}`);
console.log(`  January 2028 = loan month      : ${jan2028Month}`);
console.log(`  Lump sum fire months           : ${t3LsFireMonths.join(', ')}`);
if (jun27Row) console.log(`  Month ${june2027Month} (June 2027): lumpSum=${fmt(jun27Row.lumpSum)}, endBal=${fmt(jun27Row.endBal)}`);
if (jan28Row) console.log(`  Month ${jan2028Month} (Jan 2028) : lumpSum=${fmt(jan28Row.lumpSum)}, endBal=${fmt(jan28Row.endBal)}`);

pass(Math.abs(t3Housing - baseHousing) < 0.01,
  `Housing target IDENTICAL to baseline (${fmt(t3Housing)} vs ${fmt(baseHousing)})`);
pass(t3TotalInterest < baseTotalInterest,
  `Total Interest ${fmt(t3TotalInterest)} < baseline ${fmt(baseTotalInterest)}`);
pass(t3TotalPaid < baseTotalPaid,
  `Total Paid ${fmt(t3TotalPaid)} < baseline ${fmt(baseTotalPaid)}`);
pass(jun27Row && Math.abs(jun27Row.lumpSum - 25000) < 0.01,
  `Month ${june2027Month}: $25,000 one-time fires correctly`);
pass(jan28Row && Math.abs(jan28Row.lumpSum - 5000) < 0.01,
  `Month ${jan2028Month}: $5,000 annual fires correctly`);

// Check second annual firing (Jan 2029 = month 28)
const jan2029Month = monthStrToLoanMonth('January 2029', START_DATE);
const jan29Row = t3Sched.find(r => r.monthNum === jan2029Month);
if (jan29Row) {
  pass(Math.abs(jan29Row.lumpSum - 5000) < 0.01,
    `Month ${jan2029Month} (Jan 2029): annual $5,000 fires again`);
} else {
  console.log(`  Note: loan paid off before month ${jan2029Month} (Jan 2029)`);
}

console.log('\n══════════════════════════════════════════════════════════');
