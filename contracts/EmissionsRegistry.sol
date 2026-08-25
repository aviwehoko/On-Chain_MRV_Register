// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  EmissionsRegistry
/// @author FINE7079A Assignment 1, University of the Witwatersrand
/// @notice A shared registry that lets a manufacturer file greenhouse gas emissions
///         records, lets an accredited third party verify them, and lets anyone check
///         a record without being able to change it.
///
/// @dev    THE ONE IDEA. The emissions figure itself is never stored on-chain. What is
///         stored is keccak256(report, salt) -- a fingerprint of the report. The
///         manufacturer sends the full report and the salt privately to whoever is
///         entitled to see it, and that party calls checkReport() to confirm the report
///         it was given is the one the chain has been holding since submission.
///
///         Why the salt: an emissions figure is guessable. Without a random salt,
///         anyone could hash candidate tonnages until one matched, and the privacy
///         would be worthless.
contract EmissionsRegistry {
    // =====================================================================
    // 1. ROLES
    // =====================================================================

    /// @notice The accrediting authority. Set once, at deployment.
    address public regulator;

    /// @notice Plant operators, who may submit records.
    mapping(address => bool) public isOperator;

    /// @notice Accredited verifiers, who may accept or reject records.
    mapping(address => bool) public isVerifier;

    /// @dev Modifiers keep the permission check in one place, so every restricted
    ///      function reads the same way and none of them can forget it.
    modifier onlyRegulator() {
        require(msg.sender == regulator, "EmissionsRegistry: caller is not the regulator");
        _;
    }

    modifier onlyOperator() {
        require(isOperator[msg.sender], "EmissionsRegistry: caller is not an operator");
        _;
    }

    modifier onlyVerifier() {
        require(isVerifier[msg.sender], "EmissionsRegistry: caller is not a verifier");
        _;
    }

    // =====================================================================
    // 2. DATA
    // =====================================================================

    /// @dev None is the zero value, so an unset record reads as None and the contract
    ///      can tell "does not exist" from "exists and is pending".
    enum Status {
        None,
        Submitted,
        Verified,
        Rejected
    }

    struct Facility {
        string name;
        string sector; // e.g. "Cement", "Steel", "Glass"
        address operator; // the one address allowed to file for this plant
        bool active;
        uint256 registeredAt;
    }

    struct EmissionRecord {
        uint256 facilityId;
        string period; // e.g. "2026-Q1"
        bytes32 reportHash; // keccak256(report, salt) -- the figure never appears here
        address submittedBy;
        uint256 submittedAt;
        Status status;
        address verifiedBy;
        uint256 verifiedAt;
    }

    uint256 public facilityCount;
    uint256 public recordCount;

    /// @dev Ids start at 1 so that 0 can mean "none".
    mapping(uint256 => Facility) public facilities;
    mapping(uint256 => EmissionRecord) public records;

    /// @dev All record ids belonging to a facility, so an auditor can list them.
    mapping(uint256 => uint256[]) private facilityRecordIds;

    /// @dev facilityId => keccak256(period) => record id. Stops the same plant filing
    ///      twice for the same period. A string cannot be a mapping key directly, so
    ///      the period is hashed first.
    mapping(uint256 => mapping(bytes32 => uint256)) public recordForPeriod;

    // =====================================================================
    // 3. EVENTS
    // =====================================================================

    event OperatorSet(address indexed account, bool enabled);
    event VerifierSet(address indexed account, bool enabled);

    event FacilityRegistered(
        uint256 indexed facilityId, string name, string sector, address indexed operator
    );
    event FacilityStatusChanged(uint256 indexed facilityId, bool active);

    event RecordSubmitted(
        uint256 indexed recordId,
        uint256 indexed facilityId,
        string period,
        bytes32 reportHash,
        address indexed submittedBy
    );
    event RecordVerified(uint256 indexed recordId, address indexed verifiedBy, bool accepted);

    // =====================================================================
    // 4. CONSTRUCTOR
    // =====================================================================

    /// @param _regulator The accrediting authority. Passed in rather than defaulting to
    ///        the deployer, so the manufacturer cannot deploy the registry and thereby
    ///        become the authority that accredits its own verifier.
    constructor(address _regulator) {
        require(_regulator != address(0), "EmissionsRegistry: regulator is the zero address");
        regulator = _regulator;
    }

    // =====================================================================
    // 5. ROLE ADMINISTRATION
    // =====================================================================

    /// @notice Accredit or de-accredit a plant operator.
    /// @dev One function for both directions rather than grant/revoke pairs -- fewer
    ///      functions to reason about, and revoking is just enabled = false.
    function setOperator(address account, bool enabled) external onlyRegulator {
        require(account != address(0), "EmissionsRegistry: zero address");
        isOperator[account] = enabled;
        emit OperatorSet(account, enabled);
    }

    /// @notice Accredit or de-accredit a verifier.
    function setVerifier(address account, bool enabled) external onlyRegulator {
        require(account != address(0), "EmissionsRegistry: zero address");
        isVerifier[account] = enabled;
        emit VerifierSet(account, enabled);
    }

    // =====================================================================
    // 6. FACILITIES
    // =====================================================================

    /// @notice Register a manufacturing facility. Regulator only.
    /// @param name     Plant name.
    /// @param sector   Industry sector, used off-chain to pick the applicable method.
    /// @param operator The address bound to this plant. Must already be an accredited
    ///                 operator -- accreditation comes before assignment.
    /// @return facilityId The new facility's id.
    function registerFacility(string calldata name, string calldata sector, address operator)
        external
        onlyRegulator
        returns (uint256 facilityId)
    {
        require(bytes(name).length > 0, "EmissionsRegistry: name is empty");
        require(bytes(sector).length > 0, "EmissionsRegistry: sector is empty");
        require(isOperator[operator], "EmissionsRegistry: operator is not accredited");

        facilityCount += 1;
        facilityId = facilityCount;

        facilities[facilityId] = Facility({
            name: name,
            sector: sector,
            operator: operator,
            active: true,
            registeredAt: block.timestamp
        });

        emit FacilityRegistered(facilityId, name, sector, operator);
    }

    /// @notice Suspend or reinstate a facility. Suspension blocks new submissions but
    ///         never touches records already filed -- deactivation is not deletion.
    function setFacilityActive(uint256 facilityId, bool active) external onlyRegulator {
        require(
            facilityId > 0 && facilityId <= facilityCount, "EmissionsRegistry: no such facility"
        );
        facilities[facilityId].active = active;
        emit FacilityStatusChanged(facilityId, active);
    }

    // =====================================================================
    // 7. SUBMITTING A RECORD
    // =====================================================================

    /// @notice File an emissions record as a hash of the underlying report.
    /// @param facilityId The plant being reported on. The caller must be its operator.
    /// @param period     Reporting period, e.g. "2026-Q1".
    /// @param reportHash keccak256(abi.encodePacked(report, salt)), computed off-chain.
    /// @return recordId  The new record's id.
    function submitRecord(uint256 facilityId, string calldata period, bytes32 reportHash)
        external
        onlyOperator
        returns (uint256 recordId)
    {
        require(
            facilityId > 0 && facilityId <= facilityCount, "EmissionsRegistry: no such facility"
        );

        Facility memory f = facilities[facilityId];
        require(f.active, "EmissionsRegistry: facility is suspended");
        // Two-layer check: holding the operator role means the regulator accredited this
        // address at all; being this plant's operator authorises it for this plant.
        require(f.operator == msg.sender, "EmissionsRegistry: not this facility's operator");

        require(bytes(period).length > 0, "EmissionsRegistry: period is empty");
        require(reportHash != bytes32(0), "EmissionsRegistry: report hash is empty");

        bytes32 periodKey = keccak256(bytes(period));
        require(
            recordForPeriod[facilityId][periodKey] == 0,
            "EmissionsRegistry: period already filed for this facility"
        );

        recordCount += 1;
        recordId = recordCount;

        records[recordId] = EmissionRecord({
            facilityId: facilityId,
            period: period,
            reportHash: reportHash,
            submittedBy: msg.sender,
            submittedAt: block.timestamp,
            status: Status.Submitted,
            verifiedBy: address(0),
            verifiedAt: 0
        });

        facilityRecordIds[facilityId].push(recordId);
        recordForPeriod[facilityId][periodKey] = recordId;

        emit RecordSubmitted(recordId, facilityId, period, reportHash, msg.sender);
    }

    // =====================================================================
    // 8. VERIFYING A RECORD
    // =====================================================================

    /// @notice Accept or reject a submitted record. Verifier only.
    /// @dev    THIS IS WHERE UNAUTHORISED MODIFICATION IS PREVENTED. The only fields
    ///         this function writes are status, verifiedBy and verifiedAt. Nothing in
    ///         the contract can ever overwrite reportHash, so once a record is filed the
    ///         figure behind it is fixed. There is deliberately no setter for it.
    /// @param recordId The record to decide on.
    /// @param accepted true to verify, false to reject.
    function verifyRecord(uint256 recordId, bool accepted) external onlyVerifier {
        require(recordId > 0 && recordId <= recordCount, "EmissionsRegistry: no such record");

        EmissionRecord storage r = records[recordId];
        require(r.status == Status.Submitted, "EmissionsRegistry: record is not pending");
        // A verifier must be independent of the party that filed. Nothing stops the
        // regulator accrediting one address as both, so the contract refuses here
        // rather than relying on the regulator being careful.
        require(r.submittedBy != msg.sender, "EmissionsRegistry: cannot verify own record");

        r.status = accepted ? Status.Verified : Status.Rejected;
        r.verifiedBy = msg.sender;
        r.verifiedAt = block.timestamp;

        emit RecordVerified(recordId, msg.sender, accepted);
    }

    // =====================================================================
    // 9. RETRIEVAL
    // =====================================================================

    /// @notice Full record. Readable by anyone -- the hash is what protects the figure,
    ///         not read gating.
    function getRecord(uint256 recordId) external view returns (EmissionRecord memory) {
        require(recordId > 0 && recordId <= recordCount, "EmissionsRegistry: no such record");
        return records[recordId];
    }

    /// @notice Full facility.
    function getFacility(uint256 facilityId) external view returns (Facility memory) {
        require(
            facilityId > 0 && facilityId <= facilityCount, "EmissionsRegistry: no such facility"
        );
        return facilities[facilityId];
    }

    /// @notice Every record id filed for a facility, in submission order.
    function getFacilityRecordIds(uint256 facilityId) external view returns (uint256[] memory) {
        require(
            facilityId > 0 && facilityId <= facilityCount, "EmissionsRegistry: no such facility"
        );
        return facilityRecordIds[facilityId];
    }

    /// @notice Check a privately disclosed report against the stored hash.
    /// @dev    This is the privacy argument in one function. The operator sends the
    ///         report and salt off-chain to one counterparty -- the verifier, or a
    ///         customer who needs the figure. That party calls this and learns whether
    ///         the report it was handed is the one the chain has carried since
    ///         submission. No other participant learns the emissions figure.
    /// @param recordId The record to check against.
    /// @param report   The full report text, exactly as it was hashed.
    /// @param salt     The 32-byte salt used at submission.
    /// @return true if the report and salt hash to the stored value.
    function checkReport(uint256 recordId, string calldata report, bytes32 salt)
        external
        view
        returns (bool)
    {
        require(recordId > 0 && recordId <= recordCount, "EmissionsRegistry: no such record");
        return records[recordId].reportHash == keccak256(abi.encodePacked(report, salt));
    }

    /// @notice Helper so anyone can compute a report hash the same way the contract does,
    ///         without having to trust the submitter's own tooling.
    function computeHash(string calldata report, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(report, salt));
    }
}
