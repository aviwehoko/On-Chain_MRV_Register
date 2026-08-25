/**
 * Deploy EmissionsRegistry to the local Hardhat node.
 *
 *   Terminal 1:  npx hardhat node
 *   Terminal 2:  npx hardhat run scripts/deploy.js --network localhost
 *
 * Writes deployments/<network>.json with the contract address and deployment
 * transaction hash.
 *
 * NOTE: the assignment also requires a deployment signed through MetaMask. Do that
 * one separately and cite ITS address and transaction hash in the report — the ones
 * this script prints come from a Hardhat-signed deployment.
 */
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  // The regulator is the accrediting authority, deliberately not the deployer.
  // On the local node we use account #1 so the separation is visible in the demo.
  const regulator = signers[1] ?? deployer;

  console.log(`network   : ${network.name}`);
  console.log(`deployer  : ${deployer.address}`);
  console.log(`regulator : ${regulator.address}`);

  const Factory = await ethers.getContractFactory("EmissionsRegistry");
  const registry = await Factory.connect(deployer).deploy(regulator.address);
  const tx = registry.deploymentTransaction();

  console.log(`\ndeploy tx : ${tx.hash}`);
  const receipt = await tx.wait();
  const address = await registry.getAddress();

  console.log(`address   : ${address}`);
  console.log(`block     : ${receipt.blockNumber}`);
  console.log(`gas used  : ${receipt.gasUsed.toString()}`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    contract: "EmissionsRegistry",
    address,
    deploymentTxHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    deployer: deployer.address,
    regulator: regulator.address,
    deployedAt: new Date().toISOString(),
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`\nwrote deployments/${network.name}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
