require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const RPC_URL = process.env.SEPOLIA_RPC_URL || process.env.ALCHEMY_SEPOLIA_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.ADMIN_PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PEPPER = process.env.NULLIFIER_PEPPER || process.env.SERVER_PEPPER || "rgukt-basar-voting-pepper-2026";
const DEPLOY_BLOCK = Number(process.env.DEPLOY_BLOCK || 12085048);
const ADMIN_PIN = process.env.ADMIN_PIN || "admin123";

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const relayerWallet = new ethers.Wallet(PRIVATE_KEY, provider);

const VOTING_ABI = [
  "function electionAuthority() view returns (address)",
  "function currentElectionId() view returns (uint256)",
  "function elections(uint256) view returns (uint256 id, string title, uint256 startTime, uint256 endTime, uint256 candidatesCount, bool exists)",
  "function electionCandidates(uint256, uint256) view returns (uint256 id, string name, uint256 voteCount)",
  "function hasVoted(uint256, bytes32) view returns (bool)",
  "function createElection(string _title, string[] _candidateNames, uint256 _startTime, uint256 _endTime) external returns (uint256)",
  "function castVote(uint256 _electionId, uint256 _candidateId, bytes32 _nullifier, bytes32 _receiptHash, uint256 _expiry, address _ephemeralVoter, bytes _authoritySig, bytes _voterSig) external",
  "event VoteCast(uint256 indexed electionId, bytes32 indexed nullifier, bytes32 indexed receiptHash)"
];

const votingContract = new ethers.Contract(CONTRACT_ADDRESS, VOTING_ABI, relayerWallet);
const VOTERS_FILE = path.join(__dirname, "voters.json");
const otpCache = new Map();
const activeSessions = new Map();

const mailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
});

function readVoters() {
  return JSON.parse(fs.readFileSync(VOTERS_FILE, "utf8"));
}

function writeVoters(voters) {
  fs.writeFileSync(VOTERS_FILE, JSON.stringify(voters, null, 2));
}

function computeNullifier(aadharId) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${aadharId}:${PEPPER}`));
}

async function getActiveElectionState() {
  const eId = Number(await votingContract.currentElectionId());
  if (eId === 0) return { electionId: 0, exists: false, candidates: [] };

  const info = await votingContract.elections(eId);
  const count = Number(info.candidatesCount);
  const candidates = [];
  for (let i = 1; i <= count; i++) {
    const c = await votingContract.electionCandidates(eId, i);
    candidates.push({ id: Number(c.id), name: c.name, voteCount: Number(c.voteCount) });
  }
  return {
    electionId: Number(info.id),
    title: info.title,
    startTime: Number(info.startTime),
    endTime: Number(info.endTime),
    exists: info.exists,
    candidates
  };
}

async function sendEmailOtp(toEmail, otp, electionTitle) {
  console.log(`[OTP DISPATCH] To: ${toEmail} | Code: ${otp}`);

  const brevoApiKey = process.env.BREVO_API_KEY;
  if (!brevoApiKey) {
    throw new Error("BREVO_API_KEY is missing in environment variables.");
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "api-key": brevoApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sender: { name: "Decentralized Voting Portal", email: GMAIL_USER },
      to: [{ email: toEmail }],
      subject: `Your 6-Digit Voting OTP — ${electionTitle}`,
      htmlContent: `<div style="font-family:sans-serif;padding:16px"><h2>${electionTitle} — Booth Verification</h2><p>Your 6-digit OTP is:</p><div style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#2563eb;margin:12px 0">${otp}</div><p style="font-size:13px;color:#64748b">Valid for 5 minutes.</p></div>`,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Brevo API error (${response.status}): ${errText}`);
  }
}

app.post("/api/admin/create-election", async (req, res) => {
  try {
    const { adminPin, title, candidateNames, startMode, customStartTime, durationMinutes } = req.body;
    if (String(adminPin || "") !== ADMIN_PIN) {
      return res.status(401).json({ error: "Invalid Admin PIN." });
    }
    const cleanTitle = String(title || "General Election").trim();
    const cleanCandidates = (candidateNames || []).map((c) => String(c).trim()).filter(Boolean);
    if (cleanCandidates.length < 2) {
      return res.status(400).json({ error: "Please provide at least 2 candidate names." });
    }
    const mins = Number(durationMinutes);
    if (!mins || mins < 1) {
      return res.status(400).json({ error: "Duration must be at least 1 minute." });
    }

    const existing = await getActiveElectionState();
    const nowSec = Math.floor(Date.now() / 1000);
    if (existing.exists && existing.electionId > 0 && nowSec <= existing.endTime) {
      return res.status(403).json({
        error: `Election #${existing.electionId} ("${existing.title}") is currently active/scheduled until ${new Date(existing.endTime * 1000).toLocaleTimeString()}. Wait until it ends before launching a new election.`
      });
    }

    const latestBlock = await provider.getBlock("latest");
    const chainNow = Number(latestBlock.timestamp);
    let startTime = chainNow;
    if (startMode === "scheduled" && customStartTime) {
      startTime = Math.floor(new Date(customStartTime).getTime() / 1000);
    }
    const endTime = startTime + Math.round(mins * 60);

    const tx = await votingContract.createElection(cleanTitle, cleanCandidates, startTime, endTime);
    const receipt = await tx.wait();

    const voters = readVoters().map((v) => ({ ...v, hasVoted: false }));
    writeVoters(voters);
    otpCache.clear();

    const state = await getActiveElectionState();
    res.json({
      success: true,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      election: state
    });
  } catch (err) {
    console.error("create-election error:", err);
    res.status(400).json({ error: err.reason || err.shortMessage || err.message || "Failed to create election on-chain." });
  }
});

app.post("/api/request-otp", async (req, res) => {
  try {
    const state = await getActiveElectionState();
    if (!state.exists || state.electionId === 0) {
      return res.status(400).json({ error: "No election has been created yet. Ask Admin to launch an election." });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < state.startTime) {
      return res.status(403).json({ error: "Election has not started yet. Please wait for the start time." });
    }
    if (nowSec > state.endTime) {
      return res.status(403).json({ error: "Election time window has ended. Voting is closed." });
    }

    const aadharId = String(req.body.aadharId || "").trim();
    if (!/^\d{12}$/.test(aadharId)) {
      return res.status(400).json({ error: "Please enter a valid 12-digit ID." });
    }
    const voters = readVoters();
    const voter = voters.find((v) => v.aadharId === aadharId);
    if (!voter) return res.status(404).json({ error: "ID not found in electoral roll." });
    if (voter.status !== "eligible") return res.status(403).json({ error: `Voter status is '${voter.status}'. Not eligible.` });

    const nullifier = computeNullifier(aadharId);
    if (await votingContract.hasVoted(state.electionId, nullifier)) {
      return res.status(403).json({ error: "You have already cast your vote in this election." });
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    const sessionKey = `${state.electionId}:${aadharId}`;
    const existingSession = activeSessions.get(sessionKey);
    if (existingSession && Math.floor(Date.now() / 1000) < existingSession.expiry) {
      return res.status(409).json({
        error: "Session is already active for this ID. Complete voting in your active tab or wait until it expires."
      });
    }

    otpCache.set(aadharId, {
      otp,
      electionId: state.electionId,
      email: voter.email,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    await sendEmailOtp(voter.email, otp, state.title);

    const [userPart, domainPart] = voter.email.split("@");
    const maskedEmail = `${userPart.slice(0, 2)}***@${domainPart}`;
    res.json({ message: `OTP sent to ${maskedEmail}`, maskedTarget: maskedEmail });
  } catch (err) {
    console.error("request-otp error:", err);
    res.status(500).json({ error: err.message || "Failed to send email OTP." });
  }
});

app.post("/api/verify-otp", async (req, res) => {
  try {
    const aadharId = String(req.body.aadharId || "").trim();
    const otp = String(req.body.otp || "").trim();
    const ephemeralVoter = String(req.body.ephemeralVoter || "").trim();

    if (!ethers.isAddress(ephemeralVoter)) {
      return res.status(400).json({ error: "Invalid ephemeral public address from browser." });
    }
    const cached = otpCache.get(aadharId);
    if (!cached) return res.status(400).json({ error: "No active OTP found. Request a new OTP." });
    if (Date.now() > cached.expiresAt) {
      otpCache.delete(aadharId);
      return res.status(400).json({ error: "OTP expired. Request a new one." });
    }
    if (cached.otp !== otp) {
      return res.status(401).json({ error: "Incorrect OTP. Enter the exact OTP sent to your email." });
    }

    const state = await getActiveElectionState();
    const nowSec = Math.floor(Date.now() / 1000);
    if (!state.exists || state.electionId !== cached.electionId || nowSec < state.startTime || nowSec > state.endTime) {
      return res.status(403).json({ error: "Election window is not currently active." });
    }
    otpCache.delete(aadharId);

    const nullifier = computeNullifier(aadharId);
    if (await votingContract.hasVoted(state.electionId, nullifier)) {
      return res.status(403).json({ error: "You have already voted in this election." });
    }

    const expiry = Math.min(state.endTime, nowSec + 10 * 60);
    const voucherHash = ethers.solidityPackedKeccak256(
      ["uint256", "address", "uint256"],
      [state.electionId, ephemeralVoter, expiry]
    );
    const authoritySig = await relayerWallet.signMessage(ethers.getBytes(voucherHash));

    activeSessions.set(`${state.electionId}:${aadharId}`, { expiry, nullifier });

    res.json({
      electionId: state.electionId,
      nullifier,
      expiry,
      ephemeralVoter,
      authoritySig
    });
  } catch (err) {
    console.error("verify-otp error:", err);
    res.status(500).json({ error: "OTP verification failed." });
  }
});

app.post("/api/relay-vote", async (req, res) => {
  try {
    const { aadharId, electionId, candidateId, nullifier, receiptHash, expiry, ephemeralVoter, authoritySig, voterSig } = req.body;
    if (electionId && aadharId) {
      activeSessions.delete(`${electionId}:${String(aadharId).trim()}`);
    }
    const tx = await votingContract.castVote(
      electionId,
      candidateId,
      nullifier,
      receiptHash,
      expiry,
      ephemeralVoter,
      authoritySig,
      voterSig
    );
    const receipt = await tx.wait();

    const voters = readVoters();
    const idx = voters.findIndex((v) => v.aadharId === String(aadharId || "").trim());
    if (idx !== -1) {
      voters[idx].hasVoted = true;
      writeVoters(voters);
    }
    res.json({ success: true, txHash: receipt.hash, blockNumber: receipt.blockNumber, receiptHash });
  } catch (err) {
    console.error("relay-vote error:", err);
    res.status(400).json({ error: err.reason || err.shortMessage || err.message || "Transaction reverted." });
  }
});

app.get("/api/results", async (req, res) => {
  try {
    const state = await getActiveElectionState();
    res.json({
      contractAddress: CONTRACT_ADDRESS,
      authorityAddress: relayerWallet.address,
      serverNow: Math.floor(Date.now() / 1000),
      ...state
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch live election state." });
  }
});

app.get("/api/verify-receipt/:receiptHash", async (req, res) => {
  try {
    const { receiptHash } = req.params;
    if (!/^0x[0-9a-fA-F]{64}$/.test(receiptHash)) {
      return res.status(400).json({ error: "Invalid receipt hash format." });
    }
    const latestBlock = await provider.getBlockNumber();
    const filter = votingContract.filters.VoteCast(null, null, receiptHash);
    let events = [];
    for (let to = latestBlock; to >= DEPLOY_BLOCK && events.length === 0; to -= 10) {
      const from = Math.max(DEPLOY_BLOCK, to - 9);
      events = await votingContract.queryFilter(filter, from, to);
    }
    if (events.length === 0) return res.json({ verified: false, message: "Receipt hash not found on Sepolia blockchain" });
    res.json({
      verified: true,
      electionId: Number(events[0].args.electionId),
      blockNumber: events[0].blockNumber,
      txHash: events[0].transactionHash
    });
  } catch (err) {
    res.status(500).json({ error: "RPC error while auditing receipt." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Gas Relayer Backend running on http://0.0.0.0:${PORT}`);
});
