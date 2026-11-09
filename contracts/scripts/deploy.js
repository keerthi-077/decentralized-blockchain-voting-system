require("dotenv").config({ path: "/home/keerthi/blockchain-voting/backend/.env" });
const fs = require("fs");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying Voting contract from:", deployer.address);

  const Voting = await hre.ethers.getContractFactory("Voting");
  const voting = await Voting.deploy();
  await voting.waitForDeployment();

  const addr = await voting.getAddress();
  const blockNum = await hre.ethers.provider.getBlockNumber();
  console.log("New Contract Address:", addr);
  console.log("Deployed at Sepolia Block:", blockNum);

  const envPath = "/home/keerthi/blockchain-voting/backend/.env";
  let env = fs.readFileSync(envPath, "utf8");
  env = env.replace(/CONTRACT_ADDRESS=.*/, `CONTRACT_ADDRESS="${addr}"`);
  if (!env.includes("DEPLOY_BLOCK=")) {
    env += `\nDEPLOY_BLOCK=${blockNum}\n`;
  } else {
    env = env.replace(/DEPLOY_BLOCK=.*/, `DEPLOY_BLOCK=${blockNum}`);
  }
  if (!env.includes("ADMIN_PIN=")) {
    env += `ADMIN_PIN="admin123"\n`;
  }
  fs.writeFileSync(envPath, env);
  console.log("Updated backend/.env automatically!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
