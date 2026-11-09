import { useState, useEffect , useRef } from "react";
import { ethers } from "ethers";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:5000/api";

function formatRemaining(seconds) {
  if (seconds <= 0) return "00s";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) return `${hrs}h ${String(mins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

export default function App() {
  const isAdminMode = new URLSearchParams(window.location.search).get("admin") === "true";
  const [activeTab, setActiveTab] = useState(isAdminMode ? "admin" : "vote");
  const [election, setElection] = useState(null);
  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000));

  const [step, setStep] = useState("id");
  const [aadharId, setAadharId] = useState("");
  const [otp, setOtp] = useState("");
  const [maskedTarget, setMaskedTarget] = useState("");
  const [ephemeralWallet, setEphemeralWallet] = useState(null);
  const [sessionVoucher, setSessionVoucher] = useState(null);
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [receiptData, setReceiptData] = useState(null);

  const [auditInput, setAuditInput] = useState("");
  const [auditResult, setAuditResult] = useState(null);

  const [adminPin, setAdminPin] = useState("");
  const [electionTitle, setElectionTitle] = useState("Student Council Election");
  const [candidateInputs, setCandidateInputs] = useState(["Candidate A", "Candidate B", "Candidate C"]);
  const [startMode, setStartMode] = useState("now");
  const [customStartTime, setCustomStartTime] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [adminSuccess, setAdminSuccess] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [storageTick, setStorageTick] = useState(0);
  const prevElectionIdRef = useRef(null);
  const wasElectionLiveRef = useRef(false);

  const resetAdminSetupForm = () => {
    setAdminPin("");
    setElectionTitle("Student Council Election");
    setCandidateInputs(["Candidate A", "Candidate B", "Candidate C"]);
    setStartMode("now");
    setCustomStartTime("");
    setDurationMinutes(30);
    setAdminSuccess(null);
    setError("");
  };

  useEffect(() => {
    if (!election || !election.exists || Number(election.electionId) === 0) return;
    const isCurrentlyLive = nowSec >= Number(election.startTime) && nowSec <= Number(election.endTime);
    const hasEnded = nowSec > Number(election.endTime);

    if (isCurrentlyLive) {
      wasElectionLiveRef.current = true;
    } else if (hasEnded && wasElectionLiveRef.current) {
      wasElectionLiveRef.current = false;
      resetAdminSetupForm();
    }
  }, [election?.electionId, election?.startTime, election?.endTime, nowSec]);

  const resetAllElectionViews = () => {
    setStep("id");
    setAadharId("");
    setOtp("");
    setMaskedTarget("");
    setEphemeralWallet(null);
    setSessionVoucher(null);
    setSelectedCandidate(null);
    setReceiptData(null);
    setAuditInput("");
    setAuditResult(null);
    setError("");
    try { localStorage.removeItem("active_voter_lock"); } catch {}
  };

  const getActiveTabLock = (checkId) => {
    try {
      const raw = localStorage.getItem("active_voter_lock");
      if (!raw) return null;
      const lock = JSON.parse(raw);
      const now = Math.floor(Date.now() / 1000);
      if (now >= Number(lock.expiry) || (election?.electionId && Number(lock.electionId) !== Number(election.electionId))) {
        localStorage.removeItem("active_voter_lock");
        return null;
      }
      if (checkId && String(lock.voterId).trim() === String(checkId).trim()) {
        return lock;
      }
      return null;
    } catch {
      return null;
    }
  };

  const isSessionExpiredNow = () => {
    if (!sessionVoucher || !sessionVoucher.expiry) return false;
    if (Math.floor(Date.now() / 1000) >= Number(sessionVoucher.expiry)) {
      setError("Session voucher expired. Please verify your ID again to cast your vote.");
      return true;
    }
    return false;
  };

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === "active_voter_lock") setStorageTick((t) => t + 1);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const currentId = election?.electionId ? Number(election.electionId) : null;
    if (!currentId) return;
    if (prevElectionIdRef.current !== null && prevElectionIdRef.current !== currentId) {
      resetAllElectionViews();
    }
    prevElectionIdRef.current = currentId;
  }, [election?.electionId]);

  async function fetchElectionState() {
    try {
      const res = await fetch(`${API_BASE}/results`);
      const data = await res.json();
      if (res.ok) setElection(data);
    } catch (_) {}
  }

  useEffect(() => {
    fetchElectionState();
    const poll = setInterval(fetchElectionState, 10000);
    const tick = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const hasElection = election && election.exists && election.electionId > 0;
  const isBeforeStart = hasElection && nowSec < election.startTime;
  const isAfterEnd = hasElection && nowSec > election.endTime;
  const isElectionActive = hasElection && !isBeforeStart && !isAfterEnd;

  async function handleRequestOtp(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/request-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aadharId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send OTP");
      setMaskedTarget(data.maskedTarget);
      setStep("otp");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const freshWallet = ethers.Wallet.createRandom();
      const res = await fetch(`${API_BASE}/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aadharId,
          otp,
          ephemeralVoter: freshWallet.address
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "OTP verification failed");

      setEphemeralWallet(freshWallet);
      setSessionVoucher(data);
      await fetchElectionState();
      setStep("ballot");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCastVote() {
    if (!selectedCandidate) {
      setError("Please select a candidate before casting your vote.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const secretSalt = ethers.hexlify(ethers.randomBytes(16));
      const receiptHash = ethers.solidityPackedKeccak256(
        ["bytes32", "uint256", "string"],
        [sessionVoucher.nullifier, selectedCandidate, secretSalt]
      );

      const ballotHash = ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "bytes32", "bytes32"],
        [sessionVoucher.electionId, selectedCandidate, sessionVoucher.nullifier, receiptHash]
      );
      const voterSig = await ephemeralWallet.signMessage(ethers.getBytes(ballotHash));

      const res = await fetch(`${API_BASE}/relay-vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aadharId,
          electionId: sessionVoucher.electionId,
          candidateId: selectedCandidate,
          nullifier: sessionVoucher.nullifier,
          receiptHash,
          expiry: sessionVoucher.expiry,
          ephemeralVoter: sessionVoucher.ephemeralVoter,
          authoritySig: sessionVoucher.authoritySig,
          voterSig
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to relay vote");

      setEphemeralWallet(null);
      setReceiptData(data);
      setStep("done");
      fetchElectionState();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAuditReceipt(e) {
    e.preventDefault();
    setError("");
    setAuditResult(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/verify-receipt/${auditInput.trim()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Audit failed");
      setAuditResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateElection(e) {
    e.preventDefault();
    setError("");
    setAdminSuccess(null);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/admin/create-election`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminPin,
          title: electionTitle,
          candidateNames: candidateInputs,
          startMode,
          customStartTime,
          durationMinutes: Number(durationMinutes)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create election");
      setAdminSuccess(data);
      setElection(data.election);
      resetVoterFlow();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function resetVoterFlow() {
    setStep("id");
    setAadharId("");
    setOtp("");
    setEphemeralWallet(null);
    setSessionVoucher(null);
    setSelectedCandidate(null);
    setReceiptData(null);
    setAuditInput("");
    setAuditResult(null);
    setError("");
  }

  return (
    <div style={{ maxWidth: 680, margin: "32px auto", fontFamily: "system-ui, sans-serif", padding: "0 16px", color: "#0f172a" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Decentralized blockchain voting system</h1>
      <hr style={{ border: "none", borderTop: "1px solid #cbd5e1", margin: "16px 0" }} />

      {hasElection ? (
        <div style={{
          padding: "12px 16px",
          borderRadius: 8,
          marginBottom: 16,
          background: isElectionActive ? "#ecfdf5" : isBeforeStart ? "#eff6ff" : "#fef2f2",
          border: `1px solid ${isElectionActive ? "#a7f3d0" : isBeforeStart ? "#bfdbfe" : "#fecaca"}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 8
        }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>ELECTION #{election.electionId}</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{election.title}</div>
          </div>
          <div style={{ textAlign: "right", fontSize: 13, fontWeight: 600 }}>
            {isElectionActive && (
              <span style={{ color: "#047857" }}>LIVE • Ends in {formatRemaining(election.endTime - nowSec)}</span>
            )}
            {isBeforeStart && (
              <span style={{ color: "#1d4ed8" }}>SCHEDULED • Starts in {formatRemaining(election.startTime - nowSec)}</span>
            )}
            {isAfterEnd && (
              <span style={{ color: "#b91c1c" }}>CLOSED • Election Window Ended</span>
            )}
          </div>
        </div>
      ) : (
        <div style={{ padding: 12, borderRadius: 8, marginBottom: 16, background: "#fffbeb", border: "1px solid #fde68a", fontSize: 13, color: "#92400e" }}>
          No active election on-chain yet. Open <strong>4. Admin Setup</strong> to launch an election with your chosen candidates and duration.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
        {[
          ["vote", "1. Cast Vote"],
          ["tally", "2. Live Tally"],
          ["audit", "3. Receipt Audit"],
          ...(isAdminMode ? [["admin", "4. Admin Setup"]] : [])
        ].map(([key, label]) => (
          <button
            key={key}
            onClick={() => { setActiveTab(key); setError(""); if (key !== "audit") { setAuditInput(""); setAuditResult(null); } }}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              background: activeTab === key ? "#0f172a" : "#ffffff",
              color: activeTab === key ? "#ffffff" : "#0f172a",
              fontWeight: 600,
              cursor: "pointer"
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", color: "#991b1b", padding: 12, borderRadius: 8, marginBottom: 16, fontSize: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span>{error}</span>
          {error.toLowerCase().includes("expired") && (
            <button
              type="button"
              onClick={resetVoterFlow}
              style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#991b1b", color: "#ffffff", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
            >
              Try Again
            </button>
          )}
        </div>
      )}

      {activeTab === "vote" && (
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 24, background: "#ffffff" }}>
          {!isElectionActive ? (
            <div style={{ textAlign: "center", padding: "16px 0", color: "#475569" }}>
              <h3 style={{ marginTop: 0 }}>
                {!hasElection ? "Waiting for Election Setup" : isBeforeStart ? "Voting Booth Opens Soon" : "Voting Booth Closed"}
              </h3>
              <p style={{ fontSize: 14 }}>
                {!hasElection
                  ? "Use the Admin Setup tab to configure candidates and start an election."
                  : isBeforeStart
                  ? `Voting starts at ${new Date(election.startTime * 1000).toLocaleTimeString()}.`
                  : `Voting closed at ${new Date(election.endTime * 1000).toLocaleTimeString()}. View final results in Live Tally.`}
              </p>
            </div>
          ) : (
            <>
              {step === "id" && (
                <form onSubmit={handleRequestOtp}>
                  <h2 style={{ fontSize: 18, marginTop: 0 }}>Voter Identity Verification</h2>
                  <p style={{ fontSize: 14, color: "#475569" }}>Enter your 12-digit ID to receive a verification OTP on your registered Gmail address.</p>
                  <input
                    type="text"
                    maxLength={12}
                    placeholder="Enter 12-digit ID"
                    value={aadharId}
                    onChange={(e) => setAadharId(e.target.value.replace(/\D/g, ""))}
                    required
                    style={{ width: "100%", padding: 12, fontSize: 16, borderRadius: 8, border: "1px solid #cbd5e1", marginBottom: 12, boxSizing: "border-box" }}
                  />
                  {getActiveTabLock(aadharId) && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm font-medium">
                  Session is already active for this ID. Complete voting in your active tab or wait until it expires.
                </div>
              )}
              <button
                    type="submit"
                    disabled={loading || Boolean(getActiveTabLock(aadharId))}
                    style={{ width: "100%", padding: 12, borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer" }}
                  >
                    {loading ? "Sending OTP..." : "Send OTP to Registered Email"}
                  </button>
                </form>
              )}

              {step === "otp" && (
                <form onSubmit={handleVerifyOtp}>
                  <h2 style={{ fontSize: 18, marginTop: 0 }}>Enter 6-Digit Email OTP</h2>
                  <p style={{ fontSize: 14, color: "#475569" }}>OTP sent to <strong>{maskedTarget}</strong> (valid for 5 minutes).</p>
                  <input
                    type="text"
                    maxLength={6}
                    placeholder="6-digit OTP"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                    required
                    style={{ width: "100%", padding: 12, fontSize: 18, letterSpacing: 6, borderRadius: 8, border: "1px solid #cbd5e1", marginBottom: 12, boxSizing: "border-box" }}
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    style={{ width: "100%", padding: 12, borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer" }}
                  >
                    {loading ? "Generating Ephemeral Keypair..." : "Verify OTP & Enter Booth"}
                  </button>
                </form>
              )}

              {step === "ballot" && (
                <div>
                  <h2 style={{ fontSize: 18, marginTop: 0 }}>Official Digital Ballot — {election.title}</h2>
                  <div style={{ fontSize: 12, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 8, marginBottom: 16 }}>
                    In-Memory Ephemeral Public Address: <code>{sessionVoucher?.ephemeralVoter}</code>
                  </div>
                  {(election.candidates || []).map((c) => (
                    <label
                      key={c.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: 14,
                        border: selectedCandidate === c.id ? "2px solid #2563eb" : "1px solid #cbd5e1",
                        borderRadius: 8,
                        marginBottom: 10,
                        cursor: "pointer"
                      }}
                    >
                      <input
                        type="radio"
                        name="candidate"
                        checked={selectedCandidate === c.id}
                        onChange={() => { if (isSessionExpiredNow()) return; setSelectedCandidate(c.id); }}
                      />
                      <span style={{ fontWeight: 600 }}>{c.name}</span>
                    </label>
                  ))}
                  <button
                    onClick={handleCastVote}
                    disabled={loading}
                    style={{ width: "100%", padding: 12, borderRadius: 8, border: "none", background: "#16a34a", color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer", marginTop: 8 }}
                  >
                    {loading ? "Mining Vote on Ethereum Sepolia..." : "Sign & Cast Vote Gaslessly"}
                  </button>
                </div>
              )}

              {step === "done" && receiptData && (
                <div>
                  <h2 style={{ fontSize: 18, color: "#16a34a", marginTop: 0 }}>Vote Confirmed on Ethereum Sepolia!</h2>
                  <p style={{ fontSize: 14, color: "#475569" }}>Your ephemeral key was erased from RAM. Save your receipt hash below:</p>
                  <div style={{ background: "#f8fafc", border: "1px solid #cbd5e1", padding: 12, borderRadius: 8, fontSize: 13, wordBreak: "break-all" }}>
                    <p><strong>Receipt Hash:</strong><br /><code>{receiptData.receiptHash}</code></p>
                    <p><strong>Sepolia Tx Hash:</strong><br /><a href={`https://sepolia.etherscan.io/tx/${receiptData.txHash}`} target="_blank" rel="noreferrer">{receiptData.txHash}</a></p>
                    <p style={{ marginBottom: 0 }}><strong>Block Number:</strong> {receiptData.blockNumber}</p>
                  </div>
                  <button
                    onClick={resetVoterFlow}
                    style={{ marginTop: 14, padding: "10px 16px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" }}
                  >
                    Next Voter
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "tally" && (
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 24, background: "#ffffff" }}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>
            Live On-Chain Vote Tally {hasElection ? `(${election.title})` : ""}
          </h2>
          {hasElection && (
            <p style={{ fontSize: 13, color: "#475569" }}>
              Window: {new Date(election.startTime * 1000).toLocaleString()} — {new Date(election.endTime * 1000).toLocaleString()}
            </p>
          )}
          {(election?.candidates || []).map((c) => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid #e2e8f0" }}>
              <span style={{ fontWeight: 600 }}>{c.name}</span>
              <span style={{ fontWeight: 700, color: "#2563eb" }}>{c.voteCount} votes</span>
            </div>
          ))}
        </div>
      )}

      {activeTab === "audit" && (
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 24, background: "#ffffff" }}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Public Receipt Audit</h2>
          <form onSubmit={handleAuditReceipt}>
            <input
              type="text"
              placeholder="0x..."
              value={auditInput}
              onChange={(e) => setAuditInput(e.target.value)}
              required
              style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #cbd5e1", marginBottom: 12, boxSizing: "border-box" }}
            />
            <button type="submit" disabled={loading} style={{ padding: "10px 18px", borderRadius: 8, border: "none", background: "#0f172a", color: "#fff", fontWeight: 600, cursor: "pointer" }}>
              {loading ? "Scanning Sepolia Logs..." : "Verify on Blockchain"}
            </button>
          </form>
          {auditResult && (
            <div style={{ marginTop: 16, padding: 14, borderRadius: 8, background: auditResult.verified ? "#f0fdf4" : "#fef2f2", border: "1px solid #cbd5e1", fontSize: 13, wordBreak: "break-all" }}>
              {auditResult.verified ? (
                <>
                  <strong style={{ color: "#16a34a" }}>Verified on Ethereum Sepolia!</strong>
                  <p><strong>Election ID:</strong> #{auditResult.electionId}</p>
                  <p><strong>Block:</strong> {auditResult.blockNumber}</p>
                  <p style={{ marginBottom: 0 }}><strong>Tx Hash:</strong> {auditResult.txHash}</p>
                </>
              ) : (
                <strong style={{ color: "#dc2626" }}>{auditResult.message}</strong>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === "admin" && (
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 24, background: "#ffffff" }}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Admin Election Setup (On-Chain Deployment)</h2>
          {hasElection && !isAfterEnd ? (
            <div style={{ padding: 16, borderRadius: 8, background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", fontSize: 14 }}>
              <strong>Admin Setup Locked During Active Election</strong>
              <p style={{ marginBottom: 6 }}>
                <strong>Election #{election.electionId} ({election.title})</strong> is currently {isBeforeStart ? "scheduled" : "live"}.
              </p>
              <p style={{ margin: 0 }}>
                A new election cannot be configured until the current window ends at <strong>{new Date(election.endTime * 1000).toLocaleString()}</strong> ({formatRemaining(election.endTime - nowSec)} remaining).
              </p>
            </div>
          ) : (
            <>
          <form onSubmit={handleCreateElection}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Admin PIN</label>
            <input
              type="password"
              placeholder="Enter Admin PIN"
              value={adminPin}
              onChange={(e) => setAdminPin(e.target.value)}
              required
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #cbd5e1", marginBottom: 12, boxSizing: "border-box" }}
            />

            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Election Title</label>
            <input
              type="text"
              placeholder="e.g., CSE Class Representative Election"
              value={electionTitle}
              onChange={(e) => setElectionTitle(e.target.value)}
              required
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #cbd5e1", marginBottom: 12, boxSizing: "border-box" }}
            />

            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Candidates</label>
            {candidateInputs.map((name, idx) => (
              <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input
                  type="text"
                  placeholder={`Candidate ${idx + 1} Name`}
                  value={name}
                  onChange={(e) => {
                    const updated = [...candidateInputs];
                    updated[idx] = e.target.value;
                    setCandidateInputs(updated);
                  }}
                  required
                  style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid #cbd5e1" }}
                />
                {candidateInputs.length > 2 && (
                  <button
                    type="button"
                    onClick={() => setCandidateInputs(candidateInputs.filter((_, i) => i !== idx))}
                    style={{ padding: "0 12px", borderRadius: 8, border: "1px solid #fca5a5", background: "#fee2e2", color: "#991b1b", cursor: "pointer" }}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => setCandidateInputs([...candidateInputs, ""])}
              style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#f8fafc", fontSize: 13, cursor: "pointer", marginBottom: 14 }}
            >
              + Add Another Candidate
            </button>

            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Start Time</label>
            <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
              <label style={{ fontSize: 14 }}>
                <input type="radio" checked={startMode === "now"} onChange={() => setStartMode("now")} /> Start Immediately
              </label>
              <label style={{ fontSize: 14 }}>
                <input type="radio" checked={startMode === "scheduled"} onChange={() => setStartMode("scheduled")} /> Schedule Start Time
              </label>
            </div>
            {startMode === "scheduled" && (
              <input
                type="datetime-local"
                value={customStartTime}
                onChange={(e) => setCustomStartTime(e.target.value)}
                required
                style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #cbd5e1", marginBottom: 12, boxSizing: "border-box" }}
              />
            )}

            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Election Duration (Minutes)</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              {[
                [30, "30 Mins"],
                [60, "1 Hour"],
                [180, "3 Hours"],
                [1440, "1 Day (24 Hrs)"]
              ].map(([mins, label]) => (
                <button
                  key={mins}
                  type="button"
                  onClick={() => setDurationMinutes(mins)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 8,
                    border: Number(durationMinutes) === mins ? "2px solid #2563eb" : "1px solid #cbd5e1",
                    background: Number(durationMinutes) === mins ? "#eff6ff" : "#fff",
                    fontSize: 13,
                    cursor: "pointer"
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={1}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value)}
              required
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #cbd5e1", marginBottom: 16, boxSizing: "border-box" }}
            />

            <button
              type="submit"
              disabled={loading}
              style={{ width: "100%", padding: 12, borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", fontWeight: 600, fontSize: 15, cursor: "pointer" }}
            >
              {loading ? "Mining New Election on Sepolia..." : "Launch Time-Bound Election on Blockchain"}
            </button>
          </form>

          {adminSuccess && (
            <div style={{ marginTop: 16, padding: 14, borderRadius: 8, background: "#f0fdf4", border: "1px solid #86efac", fontSize: 13, wordBreak: "break-all" }}>
              <strong style={{ color: "#15803d" }}>Election #{adminSuccess.election.electionId} Live on Sepolia!</strong>
              <p><strong>Tx Hash:</strong> {adminSuccess.txHash}</p>
              <p style={{ marginBottom: 0 }}><strong>Closes At:</strong> {new Date(adminSuccess.election.endTime * 1000).toLocaleString()}</p>
            </div>
          )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
