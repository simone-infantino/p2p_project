// hardhat.config.ts
import { defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // In-process simulated chain — good for tests and gas measurement.
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
    },
    // Your external geth node.
    local: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
      // accounts: ["0x...privatekey..."]  // filled in by your setup script
    },
  },
});