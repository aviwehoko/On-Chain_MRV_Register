require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    offline: true,
    outputFile: process.env.GAS_OUT || undefined,
    noColors: !!process.env.GAS_OUT,
  },
};
