On-Chain MRV Register

A permissioned-ledger register for greenhouse gas Monitoring, Reporting and Verification (MRV), written in Solidity.

A South African manufacturer with EU export exposure reports the same emissions figures into three regimes that do not recognise each other's assurance: the DFFE's SAGERS system, SARS for the carbon tax, and the EU's Carbon Border Adjustment Mechanism. The same number is measured once and then attested three times, separately, with no shared record that it is the same number.

This contract is the shared record. A plant files a commitment to its emissions report, an accredited verifier accepts or rejects it, and the result is a timestamped, immutable attestation any of the three can read, without the underlying figure ever becoming public.

A conventional database handles MRV inside a single firm perfectly well. The ledger earns its cost only at the boundary between organisations that do not trust each other and answer to different authorities. That is the only claim made here.

Lifecycle
regulator  ──accredits──>  operator, verifier
regulator  ──registers──>  facility (bound to one operator)
operator   ──submits───>   record    (hash of the report + evidence URI)
verifier   ──decides───>   Verified | Rejected
anyone     ──reads─────>   status, who decided, when

A record carries the facility, the reporting period, keccak256(report, salt), a URI pointing at where the full report lives, and who filed it. The emissions figure itself never goes on chain.

Design decisions

The parts worth reading, and why they are the way they are.

The regulator is named at construction, not inherited from the deployer. If the contract defaulted to msg.sender, the manufacturer could deploy the registry and thereby become the authority that accredits its own verifier. The constructor takes the regulator as an argument so that cannot happen.

The report hash has no setter. verifyRecord writes exactly three fields: status, verifiedBy, verifiedAt. Nothing anywhere in the contract can overwrite reportHash. Once a figure is filed it is fixed, and a test asserts precisely this.

A verifier cannot verify its own submission. Nothing stops a regulator from accrediting one address as both operator and verifier, so the contract refuses at the point of use rather than trusting the regulator to be careful.

Authorisation is two layers. Holding the operator role means the regulator accredited the address at all. Being bound to a facility authorises it for that specific plant. Both are required to file.

Selective disclosure through salted commitments. The operator sends the report and salt off chain to one counterparty, who calls checkReport and learns whether the document they were handed is the one the chain has carried since submission. No other participant learns the figure. computeHash lets anyone reproduce the hash without trusting the submitter's tooling.

Suspension is not deletion. Deactivating a facility blocks new submissions and never touches records already filed.

Double-filing is blocked on the period, not the end date. The key is keccak256(periodStart, periodEnd), because a quarterly and an annual filing can legitimately share an end date.

Status.None is the zero value, so an unset record reads as "does not exist" rather than being indistinguishable from one that is pending.

Running it

Requires Node.js 18 or newer.

bash
npm install
npx hardhat test

To exercise the full lifecycle against a local chain, in two terminals:

bash
npx hardhat node                                    # terminal 1
npx hardhat run scripts/deploy.js --network localhost   # terminal 2
npx hardhat run scripts/demo.js   --network localhost

deploy.js writes the contract address, deployment transaction hash, block number and gas used to deployments/localhost.json. demo.js reads that file and walks the whole flow, printing a transaction hash and gas figure per step: accreditation, facility registration, submission, verification, a successful checkReport, and a tampered report failing the same check.

Gas report:

bash
REPORT_GAS=true npx hardhat test
Tests
bash
npx hardhat test

39 tests across seven groups:

Group	Covers
Deployment	Regulator stored, deployer not privileged, zero address refused
Role administration	Accreditation both directions, non-regulator refused, de-accreditation blocks filing
registerFacility	Field storage, ids from 1, empty name or sector refused, unaccredited operator refused, suspension
submitRecord	Hash stored and event emitted, wrong caller refused, unbound operator refused, inverted or open period refused, duplicate period refused
verifyRecord	Submitted to Verified and Rejected, report hash never altered, regulator cannot verify, no double decision, no self-verification
checkReport	Correct report accepted, altered figure rejected, wrong salt rejected, agrees with an off-chain hash, two salts over one report look unrelated
Retrieval	Readable with no role at all, record listing, unknown ids revert
Project structure
.
├── contracts/
│   └── EmissionsRegistry.sol     The contract, 314 lines
├── test/
│   └── EmissionsRegistry.test.js 39 tests
├── scripts/
│   ├── deploy.js                 Deploys, writes deployments/<network>.json
│   └── demo.js                   End-to-end lifecycle walkthrough with gas
└── hardhat.config.js             Solidity 0.8.28, optimizer on, 200 runs

Roles are hand-rolled rather than pulled from OpenZeppelin's AccessControl. Three fixed roles with no hierarchy or role admin did not justify the dependency, and the permission logic stays readable in one file.

Scope

Built as a Blockchain project. It runs against a local Hardhat node and is not deployed to any public network. The intended production setting is a permissioned network (Besu or Quorum style, IBFT2 or proof of authority), where the participants are known institutions and the validator set is itself a governance decision. There is no upgrade path, no formal verification, and no audit.

MIT licensed.
