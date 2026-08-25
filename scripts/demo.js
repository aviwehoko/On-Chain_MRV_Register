/**
 * End-to-end walkthrough against the local node. This is the script behind the
 * demonstration video: it runs the whole lifecycle in order and prints the gas
 * each step costs.
 *
 *   Terminal 1:  npx hardhat node
 *   Terminal 2:  npx hardhat run scripts/deploy.js --network localhost
 *                npx hardhat run scripts/demo.js   --network localhost
 */
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const STATUS = ["None", "Submitted", "Verified", "Rejected"];

// The full report. This is what the plant sends privately to the verifier.
// Only its hash ever reaches the chain.
const REPORT = JSON.stringify({
  facility: "Plant A",
  period: "2026-Q1",
  method: "IPCC 2006 Tier 2",
  activity_data_t: 295389.55,
  emission_factor: 0.514406,
  tonnes_co2e: 245388.017,
});

// Where the full report lives off-chain. The chain carries the fingerprint; this
// says where to find the document it fingerprints.
const EVIDENCE_URI = "ipfs://QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o";

// Q1 2026, a period that has already closed.
const Q1_START = 1767225600; // 2026-01-01T00:00:00Z
const Q1_END = 1774915200;   // 2026-03-31T00:00:00Z

function line(label, value) {
  console.log(`   ${label.padEnd(24)} ${value}`);
}

async function step(n, title, promise) {
  console.log(`\n[${n}] ${title}`);
  const receipt = await (await promise).wait();
  line("tx hash", receipt.hash);
  line("gas used", receipt.gasUsed.toString());
  return receipt;
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found. Run scripts/deploy.js --network ${network.name} first.`);
  }
  const { address } = JSON.parse(fs.readFileSync(file, "utf8"));

  const [, regulator, operator, verifier, auditor] = await ethers.getSigners();
  const registry = await ethers.getContractAt("EmissionsRegistry", address);

  console.log("EmissionsRegistry — lifecycle demonstration");
  console.log("===========================================");
  line("contract", address);
  line("regulator", regulator.address);
  line("operator", operator.address);
  line("verifier", verifier.address);
  line("auditor (no role)", auditor.address);

  // -- Accreditation ---------------------------------------------------
  await step(1, "Regulator accredits the plant operator",
    registry.connect(regulator).setOperator(operator.address, true));

  await step(2, "Regulator accredits the third-party verifier",
    registry.connect(regulator).setVerifier(verifier.address, true));

  // -- Facility --------------------------------------------------------
  await step(3, "Regulator registers the facility",
    registry.connect(regulator).registerFacility("Plant A", "Cement", operator.address));

  // -- Access control, shown by failure --------------------------------
  console.log("\n[4] An unauthorised submission is refused");
  try {
    await registry
      .connect(auditor)
      .submitRecord(1, Q1_START, Q1_END, ethers.keccak256("0x00"), EVIDENCE_URI);
    console.log("   UNEXPECTED: the call succeeded");
  } catch (e) {
    line("reverted with", e.shortMessage ?? e.message);
  }

  // -- The hash --------------------------------------------------------
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const reportHash = ethers.keccak256(
    ethers.solidityPacked(["string", "bytes32"], [REPORT, salt])
  );

  console.log("\n    The figure that never reaches the chain:");
  line("tonnes CO2e", JSON.parse(REPORT).tonnes_co2e);
  line("salt", salt);
  line("report hash", reportHash);
  line("evidence URI", EVIDENCE_URI);

  await step(5, "Operator submits the record as a hash",
    registry.connect(operator).submitRecord(1, Q1_START, Q1_END, reportHash, EVIDENCE_URI));
  line("record id", (await registry.recordCount()).toString());

  // -- Duplicate filing is refused -------------------------------------
  console.log("\n[6] The same period cannot be filed twice");
  try {
    await registry
      .connect(operator)
      .submitRecord(1, Q1_START, Q1_END, ethers.keccak256("0x01"), EVIDENCE_URI);
    console.log("   UNEXPECTED: the call succeeded");
  } catch (e) {
    line("reverted with", e.shortMessage ?? e.message);
  }

  // -- Selective disclosure --------------------------------------------
  console.log("\n[7] The verifier checks the report it was sent privately");
  line("correct report", await registry.checkReport(1, REPORT, salt));
  const tampered = REPORT.replace("245388.017", "235388.017");
  line("understated by 10kt", await registry.checkReport(1, tampered, salt));

  // -- Verification ----------------------------------------------------
  await step(8, "Verifier accepts the record",
    registry.connect(verifier).verifyRecord(1, true));

  const r = await registry.getRecord(1);
  line("status", STATUS[Number(r.status)]);
  line("verified by", r.verifiedBy);
  line("report hash unchanged", r.reportHash === reportHash);

  // -- Immutability ----------------------------------------------------
  console.log("\n[9] The record cannot be decided again");
  try {
    await registry.connect(verifier).verifyRecord(1, false);
    console.log("   UNEXPECTED: the call succeeded");
  } catch (e) {
    line("reverted with", e.shortMessage ?? e.message);
  }

  // -- Public read -----------------------------------------------------
  console.log("\n[10] An auditor with no role reads the record");
  const asAuditor = await registry.connect(auditor).getRecord(1);
  line("facility", (await registry.getFacility(asAuditor.facilityId)).name);
  line("period", `${new Date(Number(asAuditor.periodStart) * 1000).toISOString().slice(0, 10)}` +
    ` to ${new Date(Number(asAuditor.periodEnd) * 1000).toISOString().slice(0, 10)}`);
  line("evidence URI", asAuditor.evidenceURI);
  line("status", STATUS[Number(asAuditor.status)]);
  line("records for facility 1", (await registry.getFacilityRecordIds(1)).map(String).join(", "));

  console.log("\nDone. Every state change above is a signed, timestamped transaction.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
