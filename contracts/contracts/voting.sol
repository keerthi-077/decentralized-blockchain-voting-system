// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Voting {
    address public electionAuthority;
    uint256 public currentElectionId;

    struct Candidate {
        uint256 id;
        string name;
        uint256 voteCount;
    }

    struct ElectionInfo {
        uint256 id;
        string title;
        uint256 startTime;
        uint256 endTime;
        uint256 candidatesCount;
        bool exists;
    }

    mapping(uint256 => ElectionInfo) public elections;
    mapping(uint256 => mapping(uint256 => Candidate)) public electionCandidates;
    mapping(uint256 => mapping(bytes32 => bool)) public hasVoted;

    event ElectionCreated(
        uint256 indexed electionId,
        string title,
        uint256 startTime,
        uint256 endTime,
        uint256 candidatesCount
    );

    event VoteCast(
        uint256 indexed electionId,
        bytes32 indexed nullifier,
        bytes32 indexed receiptHash
    );

    modifier onlyAuthority() {
        require(msg.sender == electionAuthority, "Only election authority");
        _;
    }

    constructor() {
        electionAuthority = msg.sender;
    }

    function createElection(
        string memory _title,
        string[] memory _candidateNames,
        uint256 _startTime,
        uint256 _endTime
    ) external onlyAuthority returns (uint256) {
        require(_candidateNames.length >= 2, "At least 2 candidates required");
        require(_endTime > _startTime, "End time must be after start time");

        currentElectionId++;
        uint256 eId = currentElectionId;

        elections[eId] = ElectionInfo({
            id: eId,
            title: _title,
            startTime: _startTime,
            endTime: _endTime,
            candidatesCount: _candidateNames.length,
            exists: true
        });

        for (uint256 i = 0; i < _candidateNames.length; i++) {
            uint256 cId = i + 1;
            electionCandidates[eId][cId] = Candidate(cId, _candidateNames[i], 0);
        }

        emit ElectionCreated(eId, _title, _startTime, _endTime, _candidateNames.length);
        return eId;
    }

    function castVote(
        uint256 _electionId,
        uint256 _candidateId,
        bytes32 _nullifier,
        bytes32 _receiptHash,
        uint256 _expiry,
        address _ephemeralVoter,
        bytes memory _authoritySig,
        bytes memory _voterSig
    ) external {
        ElectionInfo storage e = elections[_electionId];
        require(e.exists, "Election does not exist");
        require(block.timestamp >= e.startTime, "Election has not started yet");
        require(block.timestamp <= e.endTime, "Election has ended");
        require(block.timestamp <= _expiry, "Session voucher expired");
        require(!hasVoted[_electionId][_nullifier], "Duplicate vote detected");
        require(_candidateId > 0 && _candidateId <= e.candidatesCount, "Invalid candidate");

        bytes32 voucherHash = keccak256(abi.encodePacked(_electionId, _ephemeralVoter, _expiry));
        bytes32 ethSignedVoucher = getEthSignedMessageHash(voucherHash);
        require(recoverSigner(ethSignedVoucher, _authoritySig) == electionAuthority, "Invalid authority voucher");

        bytes32 ballotHash = keccak256(abi.encodePacked(_electionId, _candidateId, _nullifier, _receiptHash));
        bytes32 ethSignedBallot = getEthSignedMessageHash(ballotHash);
        require(recoverSigner(ethSignedBallot, _voterSig) == _ephemeralVoter, "Invalid ballot signature");

        hasVoted[_electionId][_nullifier] = true;
        electionCandidates[_electionId][_candidateId].voteCount++;

        emit VoteCast(_electionId, _nullifier, _receiptHash);
    }

    function getEthSignedMessageHash(bytes32 _messageHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _messageHash));
    }

    function recoverSigner(bytes32 _ethSignedMessageHash, bytes memory _signature) internal pure returns (address) {
        require(_signature.length == 65, "Invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(_signature, 32))
            s := mload(add(_signature, 64))
            v := byte(0, mload(add(_signature, 96)))
        }
        if (v < 27) {
            v += 27;
        }
        return ecrecover(_ethSignedMessageHash, v, r, s);
    }
}
