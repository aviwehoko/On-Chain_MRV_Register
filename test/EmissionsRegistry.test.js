const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ZERO = ethers.ZeroAddress;
const Status = { None: 0n, Submitted: 1n, Verified: 2n, Rejected: 3n };

// The report that never reaches the chain. In practice this is the plant's full
// emissions calculation; here a short JSON string stands in for it.
const REPORT =
  '{"facility":"Plant A","period":"2026-Q1","method":"IPCC 2006 Tier 2","tonnes_co2e":245388.017}';

function hashReport(report, salt) {
  return ethers.keccak256(
    ethers.solidityPacked(["string", "bytes32"], [report, salt])
  );
}

describe("EmissionsRegistry", function () {
  /** Deployed, with nobody accredited yet. */
  async function deployFixture() {
    const [deployer, regulator, operator, verifier, outsider] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("EmissionsRegistry");
    const registry = await Factory.connect(deployer).deploy(regulator.address);
    await registry.waitForDeployment();
    const salt = ethers.hexlify(ethers.randomBytes(32));
    return { registry, deployer, regulator, operator, verifier, outsider, salt };
  }

  /** Operator and verifier accredited, one facility registered. */
  async function seededFixture() {
    const ctx = await deployFixture();
    const { registry, regulator, operator, verifier } = ctx;
    await registry.connect(regulator).setOperator(operator.address, true);
    await registry.connect(regulator).setVerifier(verifier.address, true);
    await registry.connect(regulator).registerFacility("Plant A", "Cement", operator.address);
    return ctx;
  }

  /** One record submitted for 2026-Q1. */
  async function submittedFixture() {
    const ctx = await seededFixture();
    const { registry, operator, salt } = ctx;
    const reportHash = hashReport(REPORT, salt);
    await registry.connect(operator).submitRecord(1, "2026-Q1", reportHash);
    return { ...ctx, reportHash };
  }

  // ===================================================================
  // Deployment
  // ===================================================================

  describe("Deployment", function () {
    it("stores the regulator named at construction", async function () {
      const { registry, regulator } = await loadFixture(deployFixture);
      expect(await registry.regulator()).to.equal(regulator.address);
    });

    it("does not privilege the deployer", async function () {
      const { registry, deployer } = await loadFixture(deployFixture);
      expect(await registry.regulator()).to.not.equal(deployer.address);
    });

    it("rejects the zero address as regulator", async function () {
      const Factory = await ethers.getContractFactory("EmissionsRegistry");
      await expect(Factory.deploy(ZERO)).to.be.revertedWith(
        "EmissionsRegistry: regulator is the zero address"
      );
    });

    it("starts with no facilities and no records", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect(await registry.facilityCount()).to.equal(0n);
      expect(await registry.recordCount()).to.equal(0n);
    });
  });

  // ===================================================================
  // Roles
  // ===================================================================

  describe("Role administration", function () {
    it("lets the regulator accredit an operator and emits the event", async function () {
      const { registry, regulator, operator } = await loadFixture(deployFixture);
      await expect(registry.connect(regulator).setOperator(operator.address, true))
        .to.emit(registry, "OperatorSet")
        .withArgs(operator.address, true);
      expect(await registry.isOperator(operator.address)).to.equal(true);
    });

    it("lets the regulator accredit a verifier", async function () {
      const { registry, regulator, verifier } = await loadFixture(deployFixture);
      await expect(registry.connect(regulator).setVerifier(verifier.address, true))
        .to.emit(registry, "VerifierSet")
        .withArgs(verifier.address, true);
      expect(await registry.isVerifier(verifier.address)).to.equal(true);
    });

    it("de-accredits by setting the same flag false", async function () {
      const { registry, regulator, operator } = await loadFixture(seededFixture);
      await registry.connect(regulator).setOperator(operator.address, false);
      expect(await registry.isOperator(operator.address)).to.equal(false);
    });

    it("refuses accreditation from anyone but the regulator", async function () {
      const { registry, outsider, operator } = await loadFixture(deployFixture);
      await expect(
        registry.connect(outsider).setOperator(operator.address, true)
      ).to.be.revertedWith("EmissionsRegistry: caller is not the regulator");
    });

    it("refuses the zero address", async function () {
      const { registry, regulator } = await loadFixture(deployFixture);
      await expect(registry.connect(regulator).setOperator(ZERO, true)).to.be.revertedWith(
        "EmissionsRegistry: zero address"
      );
    });

    it("stops a de-accredited operator from filing", async function () {
      const { registry, regulator, operator, salt } = await loadFixture(seededFixture);
      await registry.connect(regulator).setOperator(operator.address, false);
      await expect(
        registry.connect(operator).submitRecord(1, "2026-Q1", hashReport(REPORT, salt))
      ).to.be.revertedWith("EmissionsRegistry: caller is not an operator");
    });
  });

  // ===================================================================
  // Facilities
  // ===================================================================

  describe("registerFacility", function () {
    it("registers a facility and stores every field", async function () {
      const { registry, regulator, operator } = await loadFixture(deployFixture);
      await registry.connect(regulator).setOperator(operator.address, true);

      await expect(
        registry.connect(regulator).registerFacility("Plant A", "Cement", operator.address)
      )
        .to.emit(registry, "FacilityRegistered")
        .withArgs(1n, "Plant A", "Cement", operator.address);

      const f = await registry.getFacility(1);
      expect(f.name).to.equal("Plant A");
      expect(f.sector).to.equal("Cement");
      expect(f.operator).to.equal(operator.address);
      expect(f.active).to.equal(true);
      expect(f.registeredAt).to.be.greaterThan(0n);
      expect(await registry.facilityCount()).to.equal(1n);
    });

    it("numbers facilities from 1 so zero can mean none", async function () {
      const { registry, regulator, operator } = await loadFixture(seededFixture);
      await registry.connect(regulator).registerFacility("Plant B", "Steel", operator.address);
      expect(await registry.facilityCount()).to.equal(2n);
      await expect(registry.getFacility(0)).to.be.revertedWith(
        "EmissionsRegistry: no such facility"
      );
    });

    it("refuses registration by anyone but the regulator", async function () {
      const { registry, operator } = await loadFixture(seededFixture);
      await expect(
        registry.connect(operator).registerFacility("Plant B", "Steel", operator.address)
      ).to.be.revertedWith("EmissionsRegistry: caller is not the regulator");
    });

    it("refuses an empty name or sector", async function () {
      const { registry, regulator, operator } = await loadFixture(seededFixture);
      await expect(
        registry.connect(regulator).registerFacility("", "Cement", operator.address)
      ).to.be.revertedWith("EmissionsRegistry: name is empty");
      await expect(
        registry.connect(regulator).registerFacility("Plant B", "", operator.address)
      ).to.be.revertedWith("EmissionsRegistry: sector is empty");
    });

    it("refuses an operator the regulator has not accredited", async function () {
      const { registry, regulator, outsider } = await loadFixture(seededFixture);
      await expect(
        registry.connect(regulator).registerFacility("Plant B", "Steel", outsider.address)
      ).to.be.revertedWith("EmissionsRegistry: operator is not accredited");
    });

    it("suspends a facility without touching its records", async function () {
      const { registry, regulator, reportHash } = await loadFixture(submittedFixture);
      await expect(registry.connect(regulator).setFacilityActive(1, false))
        .to.emit(registry, "FacilityStatusChanged")
        .withArgs(1n, false);

      expect((await registry.getFacility(1)).active).to.equal(false);
      expect((await registry.getRecord(1)).reportHash).to.equal(reportHash);
    });

    it("blocks submissions to a suspended facility", async function () {
      const { registry, regulator, operator, salt } = await loadFixture(seededFixture);
      await registry.connect(regulator).setFacilityActive(1, false);
      await expect(
        registry.connect(operator).submitRecord(1, "2026-Q1", hashReport(REPORT, salt))
      ).to.be.revertedWith("EmissionsRegistry: facility is suspended");
    });
  });

  // ===================================================================
  // Submitting
  // ===================================================================

  describe("submitRecord", function () {
    it("stores the hash and emits the event", async function () {
      const { registry, operator, salt } = await loadFixture(seededFixture);
      const reportHash = hashReport(REPORT, salt);

      await expect(registry.connect(operator).submitRecord(1, "2026-Q1", reportHash))
        .to.emit(registry, "RecordSubmitted")
        .withArgs(1n, 1n, "2026-Q1", reportHash, operator.address);

      const r = await registry.getRecord(1);
      expect(r.facilityId).to.equal(1n);
      expect(r.period).to.equal("2026-Q1");
      expect(r.reportHash).to.equal(reportHash);
      expect(r.submittedBy).to.equal(operator.address);
      expect(r.status).to.equal(Status.Submitted);
      expect(r.verifiedBy).to.equal(ZERO);
      expect(await registry.recordCount()).to.equal(1n);
    });

    it("refuses a caller who is not an operator", async function () {
      const { registry, outsider, salt } = await loadFixture(seededFixture);
      await expect(
        registry.connect(outsider).submitRecord(1, "2026-Q1", hashReport(REPORT, salt))
      ).to.be.revertedWith("EmissionsRegistry: caller is not an operator");
    });

    it("refuses an operator who is not bound to this facility", async function () {
      const { registry, regulator, operator, outsider, salt } = await loadFixture(seededFixture);
      // outsider is accredited, but Plant A belongs to operator
      await registry.connect(regulator).setOperator(outsider.address, true);
      await expect(
        registry.connect(outsider).submitRecord(1, "2026-Q1", hashReport(REPORT, salt))
      ).to.be.revertedWith("EmissionsRegistry: not this facility's operator");
    });

    it("refuses an unknown facility", async function () {
      const { registry, operator, salt } = await loadFixture(seededFixture);
      await expect(
        registry.connect(operator).submitRecord(99, "2026-Q1", hashReport(REPORT, salt))
      ).to.be.revertedWith("EmissionsRegistry: no such facility");
    });

    it("refuses an empty period or an empty hash", async function () {
      const { registry, operator, salt } = await loadFixture(seededFixture);
      await expect(
        registry.connect(operator).submitRecord(1, "", hashReport(REPORT, salt))
      ).to.be.revertedWith("EmissionsRegistry: period is empty");
      await expect(
        registry.connect(operator).submitRecord(1, "2026-Q1", ethers.ZeroHash)
      ).to.be.revertedWith("EmissionsRegistry: report hash is empty");
    });

    it("refuses a second filing for the same period", async function () {
      const { registry, operator, salt } = await loadFixture(submittedFixture);
      await expect(
        registry.connect(operator).submitRecord(1, "2026-Q1", hashReport("different", salt))
      ).to.be.revertedWith("EmissionsRegistry: period already filed for this facility");
    });

    it("allows a different period for the same facility", async function () {
      const { registry, operator, salt } = await loadFixture(submittedFixture);
      await registry.connect(operator).submitRecord(1, "2026-Q2", hashReport("q2", salt));
      expect(await registry.recordCount()).to.equal(2n);
      expect(await registry.getFacilityRecordIds(1)).to.deep.equal([1n, 2n]);
    });
  });

  // ===================================================================
  // Verifying
  // ===================================================================

  describe("verifyRecord", function () {
    it("moves Submitted to Verified and records who decided", async function () {
      const { registry, verifier } = await loadFixture(submittedFixture);
      await expect(registry.connect(verifier).verifyRecord(1, true))
        .to.emit(registry, "RecordVerified")
        .withArgs(1n, verifier.address, true);

      const r = await registry.getRecord(1);
      expect(r.status).to.equal(Status.Verified);
      expect(r.verifiedBy).to.equal(verifier.address);
      expect(r.verifiedAt).to.be.greaterThan(0n);
    });

    it("moves Submitted to Rejected when not accepted", async function () {
      const { registry, verifier } = await loadFixture(submittedFixture);
      await registry.connect(verifier).verifyRecord(1, false);
      expect((await registry.getRecord(1)).status).to.equal(Status.Rejected);
    });

    it("never alters the report hash — this is the immutability guarantee", async function () {
      const { registry, verifier, reportHash } = await loadFixture(submittedFixture);
      await registry.connect(verifier).verifyRecord(1, true);
      expect((await registry.getRecord(1)).reportHash).to.equal(reportHash);
    });

    it("refuses a caller who is not a verifier, including the regulator", async function () {
      const { registry, operator, regulator } = await loadFixture(submittedFixture);
      await expect(registry.connect(operator).verifyRecord(1, true)).to.be.revertedWith(
        "EmissionsRegistry: caller is not a verifier"
      );
      await expect(registry.connect(regulator).verifyRecord(1, true)).to.be.revertedWith(
        "EmissionsRegistry: caller is not a verifier"
      );
    });

    it("refuses to decide the same record twice", async function () {
      const { registry, verifier } = await loadFixture(submittedFixture);
      await registry.connect(verifier).verifyRecord(1, true);
      await expect(registry.connect(verifier).verifyRecord(1, true)).to.be.revertedWith(
        "EmissionsRegistry: record is not pending"
      );
    });

    it("refuses self-verification even when one address holds both roles", async function () {
      const { registry, regulator, operator } = await loadFixture(submittedFixture);
      await registry.connect(regulator).setVerifier(operator.address, true);
      await expect(registry.connect(operator).verifyRecord(1, true)).to.be.revertedWith(
        "EmissionsRegistry: cannot verify own record"
      );
    });

    it("refuses an unknown record", async function () {
      const { registry, verifier } = await loadFixture(submittedFixture);
      await expect(registry.connect(verifier).verifyRecord(99, true)).to.be.revertedWith(
        "EmissionsRegistry: no such record"
      );
    });
  });

  // ===================================================================
  // The hash, and reading
  // ===================================================================

  describe("checkReport", function () {
    it("accepts the correct report and salt", async function () {
      const { registry, salt } = await loadFixture(submittedFixture);
      expect(await registry.checkReport(1, REPORT, salt)).to.equal(true);
    });

    it("rejects a report with the figure altered", async function () {
      const { registry, salt } = await loadFixture(submittedFixture);
      const tampered = REPORT.replace("245388.017", "235388.017");
      expect(await registry.checkReport(1, tampered, salt)).to.equal(false);
    });

    it("rejects the right report under the wrong salt", async function () {
      const { registry } = await loadFixture(submittedFixture);
      const wrongSalt = ethers.hexlify(ethers.randomBytes(32));
      expect(await registry.checkReport(1, REPORT, wrongSalt)).to.equal(false);
    });

    it("agrees with an off-chain hash of the same inputs", async function () {
      const { registry, salt, reportHash } = await loadFixture(submittedFixture);
      expect(await registry.computeHash(REPORT, salt)).to.equal(reportHash);
    });

    it("hides the figure: the same report under two salts looks unrelated", async function () {
      const s1 = ethers.hexlify(ethers.randomBytes(32));
      const s2 = ethers.hexlify(ethers.randomBytes(32));
      expect(hashReport(REPORT, s1)).to.not.equal(hashReport(REPORT, s2));
    });
  });

  describe("Retrieval", function () {
    it("is readable by an account with no role at all", async function () {
      const { registry, outsider, verifier, reportHash, salt } = await loadFixture(submittedFixture);
      await registry.connect(verifier).verifyRecord(1, true);

      const r = await registry.connect(outsider).getRecord(1);
      expect(r.reportHash).to.equal(reportHash);
      expect(r.status).to.equal(Status.Verified);
      // An auditor holding the disclosure can check it without any role
      expect(await registry.connect(outsider).checkReport(1, REPORT, salt)).to.equal(true);
    });

    it("lists a facility's records and reverts on unknown ids", async function () {
      const { registry } = await loadFixture(submittedFixture);
      expect(await registry.getFacilityRecordIds(1)).to.deep.equal([1n]);
      await expect(registry.getRecord(99)).to.be.revertedWith("EmissionsRegistry: no such record");
      await expect(registry.getFacilityRecordIds(99)).to.be.revertedWith(
        "EmissionsRegistry: no such facility"
      );
    });
  });
});
