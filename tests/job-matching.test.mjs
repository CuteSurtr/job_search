import assert from "node:assert/strict";
import test from "node:test";

import {
  extractHighlights,
  extractPay,
  isNewGradNursingRole,
  licenseFromText,
  normalizeLocation,
  postedMinutes,
  settingFromTitle,
  specialtyFromTitle,
  stableId,
  stateFromLocation,
  stateFromTitle,
  stripHtml,
  US_STATES,
} from "../lib/jobs/matching.mjs";
import { COVERED_STATES, SOURCES, SOURCES_BY_KEY, employersInState, isValidExternalPath } from "../lib/jobs/sources.mjs";

test("keeps genuine new-grad nursing titles", () => {
  const accepted = [
    "Registered Nurse Residency Program- Medical Surgical",
    "RN New Grad - All Locations - Residency for Select Units",
    "Emergency Department Registered Nurse Residency/Transition to Practice (RN)",
    "Nurse Residency Program - Durand",
    "Registered Nurse (New Grad) Emergency Department",
    "Clinical Nurse I - Cardiac Stepdown",
  ];
  for (const title of accepted) {
    assert.equal(isNewGradNursingRole(title), true, title);
  }
});

test("rejects lookalike roles a new grad cannot take", () => {
  const rejected = [
    "Certified Registered Nurse Anesthetist (CRNA) - 30",
    "Nurse Practitioner/Physician Assistant, Critical Care",
    "Nurse Residency Program Coordinator",
    "Nurse Residency Program Educator",
    "LPN - New Graduate Welcome",
    "Student Nurse Extern - Summer Residency",
    "RN Float Pool",
    "Medical Director - Integrated Behavioral Health in Primary Care",
  ];
  for (const title of rejected) {
    assert.equal(isNewGradNursingRole(title), false, title);
  }
});

test("reads Workday posting-age prose, and sorts unknown formats last", () => {
  assert.equal(postedMinutes("Posted Today"), 0);
  assert.equal(postedMinutes("Just Posted"), 0);
  assert.equal(postedMinutes("Posted Yesterday"), 24 * 60);
  assert.equal(postedMinutes("Posted 4 Days Ago"), 4 * 24 * 60);
  assert.equal(postedMinutes("Posted 30+ Days Ago"), 30 * 24 * 60);
  assert.equal(postedMinutes("Posted 6 Hours Ago"), 6 * 60);
  assert.equal(postedMinutes(""), 31 * 24 * 60);
  assert.equal(postedMinutes("Posted sometime"), 31 * 24 * 60);
});

test("collapses both Workday location shapes to City, ST", () => {
  assert.deepEqual(normalizeLocation("Suffolk, VA"), {
    label: "Suffolk, VA",
    city: "Suffolk",
    state: "VA",
  });

  // The pipe-delimited postal form previously rendered verbatim on the card.
  assert.deepEqual(
    normalizeLocation("Saint Luke's South Hospital   |   12300 Metcalf Ave   |   Overland Park   |   KS"),
    { label: "Overland Park, KS", city: "Overland Park", state: "KS" },
  );

  assert.equal(normalizeLocation("Orlando, FL, United States").label, "Orlando, FL");
  assert.equal(normalizeLocation("2 Locations").label, "Multiple locations");
  assert.equal(normalizeLocation("").label, "Multiple locations");
});

test("recovers the city when an employer names the facility instead", () => {
  // AdventHealth reports no city or state field at all — only "EMPLOYER PLACE".
  assert.deepEqual(normalizeLocation("ADVENTHEALTH OCALA", "AdventHealth"), {
    label: "Ocala",
    city: "Ocala",
    state: "Multi-state",
  });
  assert.equal(normalizeLocation("ADVENTHEALTH SHAWNEE MISSION", "AdventHealth").label, "Shawnee Mission");

  // The state code must survive re-casing rather than becoming "Tx".
  assert.equal(
    normalizeLocation("ADVENTHEALTH CENTRAL TEXAS, TX", "AdventHealth").label,
    "Central Texas, TX",
  );

  // A short, generic first word must not be stripped out of a real place name.
  assert.equal(normalizeLocation("Saint Charles, MO", "Saint Luke’s Health System").label, "Saint Charles, MO");
});

test("resolves state names as well as codes", () => {
  assert.equal(stateFromLocation("Kansas City, MO"), "MO");
  assert.equal(stateFromLocation("Columbus, Ohio"), "OH");
  assert.equal(stateFromLocation("Remote"), "Multi-state");
});

test("classifies specialty without letting 'surgical' capture med-surg", () => {
  assert.equal(specialtyFromTitle("Registered Nurse Residency Program- Medical Surgical"), "Med-Surg");
  // A bare English "or" must not read as "OR" the operating room.
  assert.equal(specialtyFromTitle("Nurse Residency - Med Surg or Float Pool"), "Med-Surg");
  // Telemetry is a cardiac unit, and wins over the med-surg half of the title.
  assert.equal(specialtyFromTitle("Nurse Residency - Med Surg or Telemetry"), "Cardiac");
  assert.equal(specialtyFromTitle("New Grad RN - Operating Room"), "Perioperative");
  assert.equal(specialtyFromTitle("Nurse Residency - NICU"), "Neonatal");
  assert.equal(specialtyFromTitle("RN Residency - Emergency Department"), "Emergency");
  assert.equal(specialtyFromTitle("Nurse Residency Program"), "General Residency");
});

test("derives the entry path from the title", () => {
  assert.equal(settingFromTitle("RN Nurse Residency Program"), "Residency");
  assert.equal(settingFromTitle("Critical Care Nurse Fellowship"), "Fellowship");
  assert.equal(settingFromTitle("Registered Nurse - New Grads"), "Staff RN");
});

test("extracts wages from both real posting formats", () => {
  // AdventHealth: labelled, unitless, en dash.
  assert.deepEqual(extractPay("Professional Resume. Pay Range: $31.53 – $52.24 Background Screening"), {
    pay: 31.53,
    payLabel: "$31.53–$52.24/hr",
  });

  // Unlabelled but unit-suffixed.
  assert.deepEqual(extractPay("Compensation is $34.00 - $48.50 per hour depending on experience."), {
    pay: 34,
    payLabel: "$34.00–$48.50/hr",
  });

  const annual = extractPay("Salary range: $72,000 - $95,000 annually.");
  assert.equal(annual.payLabel, "$72,000–$95,000/yr");
  assert.equal(annual.pay, Math.round((72000 / 2080) * 100) / 100);
});

test("never reports a bonus or benefit figure as a wage", () => {
  // These are the most common dollar figures in a nursing posting.
  const perks = [
    "Now offering a sign on bonus of $7,500 with no commitment or contract required!",
    "Adoption, Fertility and Surrogacy Reimbursement up to $10,000",
    "Tuition Assistance – $5,250/year and discounted educational opportunities",
    "Student Debt Pay Down – $10,000",
    "Qualified candidates may be eligible for up to a $7,500 sign-on bonus and relocation assistance",
    "Relocation assistance of $5,000 - $10,000 available",
  ];
  for (const text of perks) {
    assert.deepEqual(extractPay(text), { pay: null, payLabel: "Pay not listed" }, text);
  }
});

test("rejects ranges with no wage signal and implausible magnitudes", () => {
  assert.equal(extractPay("Ratios run $2 - $4 in some units").pay, null);
  assert.equal(extractPay("Pay Range: $2.00 – $5.00").pay, null);
  assert.equal(extractPay("").pay, null);
});

test("reads license flexibility from posting text", () => {
  assert.equal(licenseFromText("Candidates with NCLEX pending are encouraged to apply"), "NCLEX pending accepted");
  assert.equal(licenseFromText("Must hold a compact license or obtain one"), "Compact RN accepted");
  assert.equal(licenseFromText("Current RN license in the state of Ohio required"), "Active RN license required");
  assert.equal(licenseFromText("Join our team"), "RN license requirements vary");
});

test("turns posting HTML into readable text with list structure", () => {
  const html = "<p>Overview:</p><ul><li>BSN required</li><li>BLS certification</li></ul><script>bad()</script>";
  const text = stripHtml(html);
  assert.match(text, /Overview:/);
  assert.match(text, /• BSN required/);
  assert.doesNotMatch(text, /bad\(\)|<|>/);
});

test("pulls requirement lines out of a description", () => {
  const description = stripHtml(
    "<p>Join us today.</p><ul><li>Graduate of an accredited BSN or ADN nursing program</li>" +
      "<li>Current BLS certification from the American Heart Association</li>" +
      "<li>Free parking</li></ul>",
  );
  const highlights = extractHighlights(description);
  assert.ok(highlights.some((line) => /BSN or ADN/.test(line)));
  assert.ok(highlights.some((line) => /BLS certification/.test(line)));
  assert.ok(!highlights.some((line) => /Free parking/.test(line)));
});

test("job ids are stable and url-derived", () => {
  const url = "https://ochsner.wd1.myworkdayjobs.com/Ochsner/job/New-Orleans/RN-New-Grad_REQ_1";
  assert.equal(stableId(url), stableId(url));
  assert.notEqual(stableId(url), stableId(`${url}2`));
  assert.match(stableId(url), /^job-[a-z0-9]+$/);
});

test("only accepts Workday job paths as detail targets", () => {
  assert.equal(isValidExternalPath("/job/Orlando-FL/Nurse-Residency_25012345"), true);
  assert.equal(isValidExternalPath("/etc/passwd"), false);
  assert.equal(isValidExternalPath("/job/../../admin"), false);
  assert.equal(isValidExternalPath("https://evil.example/job/x"), false);
  assert.equal(isValidExternalPath("/job/x?redirect=1"), false);
  assert.equal(isValidExternalPath(""), false);
  assert.equal(isValidExternalPath(null), false);
});

test("source registry entries are unique and well formed", () => {
  const keys = new Set();
  for (const source of SOURCES) {
    for (const field of ["key", "name", "host", "site", "accent"]) {
      assert.equal(typeof source[field], "string", `${source.key}.${field}`);
      assert.ok(source[field].length > 0, `${source.key}.${field} is empty`);
    }
    // Duplicate keys would silently collapse detail lookups onto one employer.
    assert.ok(!keys.has(source.key), `duplicate source key: ${source.key}`);
    keys.add(source.key);

    // Host and tenant shape are ATS-specific. Asserting the Workday form
    // against every entry is what made adding a second ATS look like a
    // regression, so the invariant is now stated per system rather than
    // dropped — an Oracle entry is held to the Oracle rules just as strictly.
    if (source.ats === "oracle") {
      assert.match(source.host, /^[a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com$/, `${source.key} host`);
      assert.match(source.site, /^CX_\d+$/, `${source.key} site should be a CX site number`);
    } else {
      assert.equal(typeof source.tenant, "string", `${source.key}.tenant`);
      assert.match(source.host, /^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/, `${source.key} host`);
      assert.ok(source.host.startsWith(`${source.tenant}.`), `${source.key} host must match its tenant`);
    }

    assert.match(source.accent, /^[A-Z]{2}$/, `${source.key} accent should be two capitals`);
    assert.equal(SOURCES_BY_KEY.get(source.key), source, `${source.key} missing from lookup map`);
  }
  assert.equal(SOURCES_BY_KEY.size, SOURCES.length);
});

test("a state is never inferred from a two-letter code inside a title", () => {
  // "OR" is the operating room. Reading it as Oregon filed Ohio residencies
  // under an Oregon filter, which is worse than leaving the state unknown.
  assert.equal(stateFromTitle("OR/Surgery RN Residency w/call"), "Multi-state");
  assert.equal(stateFromTitle("Staff Nurse (RN) - New Grad OR Nurse Residency"), "Multi-state");
  assert.equal(stateFromTitle("Nurse Residency - ED and ICU"), "Multi-state");

  // Full names remain unambiguous and are still used.
  assert.equal(stateFromTitle("Nurse Residency Program - Illinois Locations"), "IL");
  assert.equal(stateFromTitle("Nurse Residency AdventHealth Hendersonville North Carolina"), "NC");
});

test("every source declares a plausible state footprint", () => {
  const valid = new Set(US_STATES.map((state) => state.code));
  for (const source of SOURCES) {
    assert.ok(Array.isArray(source.states) && source.states.length > 0, `${source.key} has no states`);
    for (const code of source.states) {
      assert.ok(valid.has(code), `${source.key} lists unknown state ${code}`);
    }
    assert.equal(new Set(source.states).size, source.states.length, `${source.key} repeats a state`);
  }
});

test("the national state list is complete and the covered set is a subset of it", () => {
  // 50 states plus DC. The filter is built from this, so a short list would
  // silently hide states from visitors.
  assert.equal(US_STATES.length, 51);
  assert.ok(US_STATES.some((state) => state.name === "Alaska"));
  assert.ok(US_STATES.some((state) => state.name === "Hawaii"));
  assert.ok(US_STATES.some((state) => state.name === "District of Columbia"));

  const valid = new Set(US_STATES.map((state) => state.code));
  for (const code of COVERED_STATES) assert.ok(valid.has(code), `covered state ${code} is not a US state`);
  assert.ok(COVERED_STATES.length > 0 && COVERED_STATES.length <= US_STATES.length);
});

test("employersInState reports who is polled where", () => {
  for (const code of COVERED_STATES) {
    assert.ok(employersInState(code).length > 0, `${code} is covered but lists no employer`);
  }
  const uncovered = US_STATES.map((state) => state.code).filter((code) => !COVERED_STATES.includes(code));
  for (const code of uncovered) {
    assert.equal(employersInState(code).length, 0, `${code} is not covered but lists employers`);
  }
});
