const bitcoin = require('bitcoinjs-lib');
const bitcoinMessage = require('bitcoinjs-message');
const { randomBytes } = require('crypto');
const Tx = require('ethereumjs-tx').Transaction;
const propertiesReader = require('properties-reader');
const Web3 = require('web3');

const { uptime } = require('./node');
const { btcClient, helpers } = require('../utils/util');
const i18n = require('../../i18n');
const { credentialTypes } = require('../config');
const { txrefToTxid } = require('../utils/tx-ref');
const ethDID = require('../services/eth.did.service');
const ipfs = require('../ipfs');
const env = require('../config/eth.env.json');
const {
  BTC_DUST,
  NO_OF_TX_OUTPUTS,
  FINAL_NO_OF_TX_INPUTS,
  FINAL_NO_OF_TX_OUTPUTS,
  OMNI_BLOCKCHAIN,
} = require('../utils/constants');

const props = propertiesReader('./etc/local.conf');
const web3 = new Web3(new Web3.providers.HttpProvider(env.ethNodeURL));

const api = exports;

let txChainLevel = 1;
let txChain = {};

/**
 * Tx Chain parsing logic
 * @param {string} txid
 * @param {string} vout
 * @param {string} blockhash
 * @returns {Object}
 */
async function parseBlocks(txid, vout, blockhash) {
  let txidBuf = txid;
  let voutBuf = vout;
  const { tx, nTx, nextblockhash } = (
    await btcClient('getblock', [blockhash, 2])
  ).result;
  for (let x = 0; x < nTx; x++) {
    const { vin, vout: currVout, txid: currTxid } = tx[x];
    for (let y = 0; y < vin.length; y++) {
      const { txid: vinTxid, vout: vinVout } = vin[y];
      if (vinTxid === txid && vinVout === vout) {
        let OP_RETURN = null;
        for (let i = 0; i < currVout.length; i++) {
          const { asm, type } = currVout[i].scriptPubKey;
          if (type === 'nulldata') {
            [OP_RETURN] = asm.split('OP_RETURN ');
          }
        }
        if (!OP_RETURN) {
          throw new Error(
            `DID continuation doc not found at level ${txChainLevel}.`,
          );
        }
        txidBuf = currTxid;
        voutBuf = currVout[0].n;
        tx[x].ddo = OP_RETURN;
        txChain[txChainLevel] = tx[x];
        txChainLevel += 1;
      }
    }
  }
  if (!nextblockhash) {
    const res = { ...txChain };
    res.final = res[txChainLevel - 1];
    txChain = {};
    txChainLevel = 1;
    return res;
  }
  return parseBlocks(txidBuf, voutBuf, nextblockhash);
}

/**
 * Funtion to obtain transactions that spent the utxos.
 * @param {string} txid
 * @param {string} vout
 * @returns {Object}
 */
async function getTxsChain(txid, vout) {
  try {
    await btcClient('gettxout', [txid, vout]);
    return {};
  } catch (errTxo) {
    const getRawTx = (await btcClient('getrawtransaction', [txid, true]))
      .result;
    const { blockhash } = getRawTx;
    return parseBlocks(txid, vout, blockhash);
  }
}

/**
 * API to check daemon's uptime.
 * @returns {object} "uptime" in milliseconds
 */
api.getuptime = (req, res) => {
  res.status(200).send({ uptime: new Date().getTime() - uptime() });
};

/**
 * API to prepare a transaction for DID creation.
 * @returns {object}
 */
api.prepareTransaction = async (req, res) => {
  const { blockchain } = req.body;
  try {
    if (blockchain === 'eth') {
      const { type } = req.body;
      if (!type) {
        return res
          .status(400)
          .send({ result: null, error: i18n('Missing parameters') });
      }
      if (type === 'create') {
        const { didDoc, publicKey } = req.body;
        if (!didDoc || !publicKey) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.create(didDoc, publicKey);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
      if (type === 'update') {
        const { didDoc, cid, publicKey } = req.body;
        if (!didDoc || !cid || !publicKey) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.setMetadata(publicKey, cid, didDoc);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
      if (type === 'transfer') {
        const { publicKey, newOwner, cid } = req.body;
        if (!newOwner || !cid || !publicKey) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.setController(publicKey, newOwner, cid);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
      if (type === 'delete') {
        const { publicKey, cid } = req.body;
        if (!publicKey || !cid) {
          return res
            .status(400)
            .send({ result: null, error: i18n('Missing parameters') });
        }
        const rawTx = await ethDID.deleteDID(publicKey, cid);
        return res.status(200).send({
          message: 'RawTx created successfully.',
          result: rawTx.data,
          error: null,
        });
      }
    }
    const { didCreator, didUpdater } = req.body;
    if (!didCreator || !didUpdater) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }

    const amount = BTC_DUST;
    let fee = 0;
    const unspents = (
      await btcClient('listunspent', [1, 9999999, [didCreator]])
    ).result;
    if (unspents.length) {
      const inputs = [];
      const outputs = {};
      fee = helpers.calculateFee(unspents.length, NO_OF_TX_OUTPUTS);
      let totalAmount = 0;
      unspents.forEach((x) => {
        inputs.push({ txid: x.txid, vout: x.vout });
        totalAmount += x.amount;
      });
      if (totalAmount >= Number(amount) + Number(fee)) {
        const changeAmt = (
          totalAmount - (Number(amount) + Number(fee))
        ).toFixed(8);
        outputs[didUpdater] = String(amount);
        if (Number(changeAmt) > 0) {
          outputs[didCreator] = changeAmt;
        }
        const rawTx = await btcClient('createrawtransaction', [
          inputs,
          outputs,
        ]);
        if (rawTx.result) {
          return res.status(200).send({
            message: 'Tx created successfully.',
            result: rawTx.result,
            error: null,
          });
        }
        return res.status(500).send({
          result: null,
          error: i18n('Error occurred while creating a raw transaction.'),
        });
      }
      return res.status(500).send({
        result: null,
        error: i18n('Sender does not have sufficient balance.'),
      });
    }
    fee = helpers.calculateFee(FINAL_NO_OF_TX_INPUTS, FINAL_NO_OF_TX_OUTPUTS);
    return res.status(500).send({
      result: null,
      error: i18n(
        `Sender does not have funds. Please fund this address "${didCreator}" with ${fee} BTC.`,
      ),
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to upload and store a document on IPFS.
 * @returns {object}
 */
api.storeDoc = async (req, res) => {
  try {
    const resp = await ipfs.upload(req);
    return res.status(200).send({
      cid: resp.data.cid,
      message: 'DID document uploaded',
      error: null,
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to broadcast a signed transaction onto BTC or ETH network.
 * @returns {object}
 */
api.broadcast = async (req, res) => {
  try {
    const { signedTx, blockchain } = req.body;
    if (!signedTx) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    let sentTx;
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    if (blockchain === 'eth') {
      sentTx = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    } else {
      sentTx = await btcClient('sendrawtransaction', [signedTx], isOmni);
    }
    return res.status(200).send({
      error: null,
      message: 'Txn sent successfully.',
      result: sentTx,
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to issue a new claim.
 * @returns {object}
 */
api.issueNewClaim = async (req, res) => {
  try {
    const {
      attestorDID,
      requestorDID,
      claimType,
      claimData,
      attestorName,
      attestorPublicKey,
      attestorPrivateKey,
      network: givenNetwork,
      blockchain,
    } = req.body;
    if (
      !attestorDID
      || !requestorDID
      || !claimType
      || !claimData
      || !attestorPublicKey
      || !attestorPrivateKey
      || !attestorName
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    if (!credentialTypes.includes(claimType)) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Invalid claimType sent.') });
    }
    let [part1, part2, part3] = attestorDID.split(':');
    if (
      part1 !== 'did'
      || part2 !== 'mdip'
      || (part3.substr(0, 3) !== 'btc' && part3.substr(0, 3) !== 'eth')
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Invalid DID sent.') });
    }
    [part1, part2, part3] = requestorDID.split(':');
    if (
      part1 !== 'did'
      || part2 !== 'mdip'
      || (part3.substr(0, 3) !== 'btc' && part3.substr(0, 3) !== 'eth')
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Invalid DID sent.') });
    }
    let claim = {};
    const validFrom = new Date().toISOString();
    const validUntil = new Date(
      Date.now() + 180 * 24 * 60 * 60 * 1000,
    ).toISOString(); // 6-months validity.
    if (
      (claimType === 'ageOver18' || claimType === 'ageOver21' || claimType === 'isPlatformXUser')
      && claimData[claimType]
    ) {
      claim = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        id: attestorDID,
        type: ['VerifiableCredential', claimType],
        issuer: {
          id: attestorDID,
          name: attestorName,
        },
        issuanceDate: validFrom,
        expirationDate: validUntil,
        credentialSubject: {
          id: requestorDID,
          [claimType]: true,
        },
      };
    }
    const message = JSON.stringify(claim);
    let signature;
    if (blockchain === 'eth') {
      const web3Instance = new Web3(new Web3.providers.HttpProvider());
      signature = await web3Instance.eth.accounts.sign(
        message,
        `0x${attestorPrivateKey}`,
      );
    } else {
      let network = bitcoin.networks.testnet;
      if (givenNetwork === 'mainnet') {
        network = bitcoin.networks.bitcoin;
      }
      const keyPair = bitcoin.ECPair.fromWIF(attestorPrivateKey, network);
      const obatinedPrivKey = keyPair.privateKey;

      signature = bitcoinMessage.sign(
        message,
        obatinedPrivKey,
        keyPair.compressed,
        { extraEntropy: randomBytes(32) },
      );
    }

    claim.proof = {
      type: 'EcdsaSecp256k1VerificationKey2019',
      created: validFrom,
      proofPurpose: 'assertionMethod',
      verificationMethod: attestorPublicKey,
      // This will be more generic e.g: did:mdip:btc-1234#pubkey1 so that id does not get hardcoded.
      jws: signature.toString('base64'),
    };
    return res.status(200).send({
      error: null,
      message: 'Verifiable claim generated successfully.',
      result: JSON.stringify(claim),
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to update a DID.
 * @returns {object}
 */
// eslint-disable-next-line consistent-return
api.updateDID = async (req, res) => {
  try {
    const {
      did,
      didUpdaterKeypair: { address, privateKey },
      newReceiver,
      network,
      didDocURL,
    } = req.body;
    if (
      !did
      || !address
      || !privateKey
      || !newReceiver
      || !network
      || !didDocURL
    ) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const isOmni = did.includes('did:mdip:omni-');
    const splitByStr = isOmni ? 'omni-' : 'btc-';
    const txRef = did.split(':')[2].split(splitByStr)[1];
    const finalTxRef = network === 'mainnet' ? `tx1:${txRef}` : `txtest1:${txRef}`;
    const { txid, utxoIndex } = await txrefToTxid(finalTxRef, btcClient);
    let txoCall;
    try {
      txoCall = await btcClient('gettxout', [txid, utxoIndex], isOmni);
    } catch (errTxo) {
      return res.status(400).send({
        error: true,
        message: 'DID already revoked.',
      });
    }
    const txo = txoCall.result;
    if (txo && txo.scriptPubKey.addresses[0] !== address) {
      return res.status(400).send({
        error: null,
        message: 'Invalid DID updater key pair provided.',
      });
    }
    if (txo) {
      let inputs = [{ txid, vout: utxoIndex }];
      const fee = helpers.calculateFee(1, 1);
      let totalAmount = txo.value;
      if (totalAmount < fee) {
        const unspents = (
          await btcClient('listunspent', [
            1,
            9999999,
            [txo.scriptPubKey.addresses[0]],
          ], isOmni)
        ).result;
        totalAmount = unspents.reduce((acc, u) => acc + u.amount, 0);
        if (totalAmount < fee) {
          return res.status(400).send({
            error: null,
            message: 'DID does not have funds to pay for update fee.',
          });
        }
        inputs = unspents.map((x) => ({ txid: x.txid, vout: x.vout }));
      }
      const outputs = { [newReceiver]: (totalAmount - fee).toFixed(8) };
      outputs.data = Buffer.from(didDocURL).toString('hex'); // OP_RETURN
      if (isOmni) {
        /**
         * data embedded for a tx to be identified as omni layer tx.
         * contains omni chain + version data
         */
        outputs.data = `6f6d6e69000000c8${outputs.data}`;
      }
      const rawTx = await btcClient('createrawtransaction', [inputs, outputs], isOmni);
      const signedTx = await btcClient('signrawtransactionwithkey', [
        rawTx.result,
        [privateKey],
      ], isOmni);
      if (signedTx.result && signedTx.result.complete) {
        const sentTx = await btcClient('sendrawtransaction', [
          signedTx.result.hex,
        ], isOmni);
        return res.status(400).send({
          error: null,
          message: `DID: ${did} updated successfully.`,
          result: sentTx,
        });
      }
      if (signedTx.result && !signedTx.result.complete) {
        return res.status(400).send({
          error: true,
          message: 'Invalid private key provided.',
        });
      }
    }
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to delete a DID.
 * @returns {object}
 */
// eslint-disable-next-line consistent-return
api.deleteDID = async (req, res) => {
  try {
    const {
      did,
      didUpdaterKeypair: { address, privateKey },
      newReceiver,
      network,
    } = req.body;
    if (!did || !address || !privateKey || !newReceiver || !network) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const isOmni = did.includes('did:mdip:omni-');
    const splitByStr = isOmni ? 'omni-' : 'btc-';
    const txRef = did.split(':')[2].split(splitByStr)[1];
    const finalTxRef = network === 'mainnet' ? `tx1:${txRef}` : `txtest1:${txRef}`;
    const { txid, utxoIndex } = await txrefToTxid(finalTxRef, btcClient, isOmni);
    let txoCall;
    try {
      txoCall = await btcClient('gettxout', [txid, utxoIndex], isOmni);
    } catch (errTxo) {
      return res.status(400).send({
        error: true,
        message: 'DID already revoked.',
      });
    }
    const txo = txoCall.result;
    if (txo && txo.scriptPubKey.addresses[0] !== address) {
      return res.status(400).send({
        error: null,
        message: 'Invalid DID updater key pair provided.',
      });
    }
    if (txo) {
      let inputs = [{ txid, vout: utxoIndex }];
      const fee = helpers.calculateFee(1, 1);
      let totalAmount = txo.value;
      if (totalAmount < fee) {
        const unspents = (
          await btcClient('listunspent', [
            1,
            9999999,
            [txo.scriptPubKey.addresses[0]],
          ], isOmni)
        ).result;
        totalAmount = unspents.reduce((acc, u) => acc + u.amount, 0);
        if (totalAmount < fee) {
          return res.status(400).send({
            error: null,
            message: 'DID does not have funds to pay for revoke fee.',
          });
        }
        inputs = unspents.map((x) => ({ txid: x.txid, vout: x.vout }));
      }
      /** TODO: validate newReceiver address. */
      const outputs = { [newReceiver]: (totalAmount - fee).toFixed(8) };
      const rawTx = await btcClient('createrawtransaction', [inputs, outputs], isOmni);
      const signedTx = await btcClient('signrawtransactionwithkey', [
        rawTx.result,
        [privateKey],
      ], isOmni);
      if (signedTx.result && signedTx.result.complete) {
        const sentTx = await btcClient('sendrawtransaction', [
          signedTx.result.hex,
        ], isOmni);
        return res.status(400).send({
          error: null,
          message: `DID: ${did} revoked successfully.`,
          result: sentTx,
        });
      }
      if (signedTx.result && !signedTx.result.complete) {
        return res.status(400).send({
          error: true,
          message: 'Invalid private key provided.',
        });
      }
    }
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to read a DID.
 * @returns {object}
 */
api.readDID = async (req, res) => {
  try {
    const { did, network } = req.body;
    if (!did || !network) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    if (network === 'eth') {
      const didTx = await ethDID.getDID(did);
      const didDoc = await ipfs.download(didTx.data.metadata);
      return res.status(200).send({
        error: null,
        message: 'DID Doucment obtained successfully.',
        result: didDoc,
      });
    }
    const isOmni = did.includes('did:mdip:omni-');
    const splitByStr = isOmni ? 'omni-' : 'btc-';
    const txRef = did.split(':')[2].split(splitByStr)[1];
    const finalTxRef = network === 'mainnet' ? `tx1:${txRef}` : `txtest1:${txRef}`;
    const { txid, utxoIndex } = await txrefToTxid(finalTxRef, btcClient);
    const resp = await getTxsChain(txid, utxoIndex);
    if (Object.keys(resp).length) {
      const {
        final: { ddo },
      } = resp;
      const didDocURL = Buffer.from(ddo, 'hex').toString();
      return res.status(200).send({
        error: null,
        result: didDocURL,
        message: 'DID Document obtained successfully.',
      });
    }
    const { vin, vout } = (
      await btcClient('getrawtransaction', [txid, true])
    ).result;
    let OP_RETURN = null;
    for (let i = 0; i < vout.length; i++) {
      const { asm, type } = vout[i].scriptPubKey;
      if (type === 'nulldata') {
        [OP_RETURN] = asm.split('OP_RETURN ');
      }
    }
    if (OP_RETURN) {
      if (isOmni) {
        OP_RETURN = OP_RETURN.substr(16);
      }
      const document = Buffer.from(OP_RETURN, 'hex').toString();
      return res.status(200).send({
        error: null,
        result: document,
        message: 'DID Document obtained successfully.',
      });
    }
    const { txid: iptxid, vout: ipvout } = vin[0];
    const iptxData = (await btcClient('getrawtransaction', [iptxid, true]))
      .result;
    const {
      scriptPubKey: { addresses },
    } = iptxData.vout[ipvout];
    const defaultCapability = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: `${did}`,
      publicKey: [
        {
          id: `${did}#auth`,
          controller: `${did}`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          publicKeyBase58: addresses[0],
        },
        {
          id: `${did}#vc-pubkey`,
          controller: `${did}`,
          type: 'EcdsaSecp256k1VerificationKey2019',
          publicKeyBase58: addresses[0],
        },
      ],
      authentication: ['#auth'],
      assertionMethod: ['#vc-pubkey'],
    };
    return res.status(200).send({
      error: null,
      message: 'DID Doucment obtained successfully.',
      result: defaultCapability,
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to obtain utxos of a given address using scantxoutset.
 * @returns {object}
 */
api.getutxos = async (req, res) => {
  try {
    const { address, blockchain } = req.body;
    if (!address) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    const { success, unspents, total_amount: totalAmount } = (
      await btcClient('scantxoutset', ['start', [{ desc: `addr(${address})` }]], isOmni)
    ).result;
    const { fee, nulldataFee } = await helpers.calculateFee(unspents.length, 3, isOmni);
    const sanitizedFee = fee.toFixed(8);
    const sanitizedNulldataFee = nulldataFee.toFixed(8);
    if (success && totalAmount >= Number(sanitizedFee)) {
      for (let i = 0; i < unspents.length; i++) {
        const { txid } = unspents[i];
        // eslint-disable-next-line no-await-in-loop
        const getTx = (await btcClient('getrawtransaction', [txid, true], isOmni)).result;
        unspents[i].rawTx = getTx;
      }
      return res.status(200).send({
        error: null,
        message: 'Inputs obtained.',
        result: { unspents, fee: sanitizedFee, nulldataFee: sanitizedNulldataFee },
      });
    }
    return res.status(200).send({
      error: true,
      message: 'Sender does not have funds.',
      result: null,
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/**
 * API to obtain confirmations on a given BTC transaction.
 * @returns {object}
 */
api.checkconfs = async (req, res) => {
  try {
    const { txids } = req.body;
    if (!txids || !txids.length) {
      return res
        .status(400)
        .send({ result: null, error: i18n('Missing parameters') });
    }
    const result = [];
    const invalidTxids = [];
    for (let i = 0; i < txids.length; i++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const tx = (await btcClient('getrawtransaction', [txids[i], true])).result;
        result.push({ txid: txids[i], confirmations: tx.confirmations });
      } catch (errGetTx) {
        invalidTxids.push(txids[i]);
      }
    }
    if (!result.length) {
      return res.status(200).send({
        error: true,
        message: `All of the given transaction ids${JSON.stringify(invalidTxids)} were invalid.`,
        result: null,
      });
    }
    return res.status(200).send({
      error: null,
      message: 'Confirmations obtained successfully.',
      result: { valid: result, invalid: invalidTxids },
    });
  } catch (errorT) {
    return res.status(500).send({ result: false, error: errorT.message });
  }
};

/** Development only service. */
/**
 * API to fund any ETH address with a specific amount.
 * @returns {object}
 */
api.fundETHAddress = async (req, res) => {
  const { toAddr } = req.body;
  if (!toAddr) {
    return res.status(400).send({ error: 'Send proper parameters.', result: null });
  }
  const amount = props.get('mdip.ethTransferAmount');
  const chainID = props.get('mdip.chainID');
  if (!props.get('mdip.ethSenderAccount') || !props.get('mdip.ethSenderPrivateKey') || !amount || !chainID) {
    return res.status(400).send({ error: 'config not set.', result: null });
  }
  const fromAddr = `0x${props.get('mdip.ethSenderAccount')}`;
  const privateKey = `0x${props.get('mdip.ethSenderPrivateKey')}`;
  try {
    const isToAddrValid = web3.utils.isAddress(toAddr);
    if (!isToAddrValid) {
      return res.status(400).send({ error: `Invalid toAddr ${toAddr} sent`, result: null });
    }
    const ethBalance = await web3.eth.getBalance(fromAddr);
    const ethBalanceDecimal = Number(web3.utils.fromWei(ethBalance, 'ether'));
    const { gas, gasPrice } = await helpers.calculateFeeETH(fromAddr, toAddr, ethBalance);
    const fee = web3.utils.fromWei(
      String(Number(gas) * Number(gasPrice)),
      'ether',
    );
    if (ethBalanceDecimal < Number(amount) + Number(fee)) {
      return res.status(400).send({
        error: `Current ETH balance ${ethBalanceDecimal} is less than required amount + fee ${
          Number(amount) + Number(fee)
        }`,
        result: null,
      });
    }
    const proPrivateKey = Buffer.from(privateKey.substr(2), 'hex');
    const nonce = await web3.eth.getTransactionCount(fromAddr, 'pending');
    const rawTx = {
      from: fromAddr,
      to: toAddr,
      value: web3.utils.toHex(web3.utils.toWei(String(amount), 'ether')),
      gas: Number(gas),
      gasPrice: Number(gasPrice),
      nonce,
    };
    const tx = new Tx(rawTx, { chain: Number(chainID) });
    tx.sign(proPrivateKey);
    const serializedTx = tx.serialize();
    const proSerializedTx = `0x${serializedTx.toString('hex')}`;
    const sentTx = await web3.eth.sendSignedTransaction(proSerializedTx);
    return res.status(200).send({
      error: null,
      message: 'Txn sent successfully.',
      result: {
        hash: sentTx.transactionHash,
        fee,
        gas,
        gasPrice,
        amount,
      },
    });
  } catch (errT) {
    if (errT && errT.message) {
      return res.status(500).send({ error: errT.message, result: null });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};

api.getTxDetails = async (req, res) => {
  const { txid, blockchain } = req.query;
  if (!txid) {
    return res.status(400).send({ error: 'Send proper parameters.', result: null });
  }
  try {
    const isOmni = blockchain === OMNI_BLOCKCHAIN;
    const getRawTx = (await btcClient('getrawtransaction', [txid, true], isOmni)).result;
    const getBlock = (await btcClient('getblock', [getRawTx.blockhash, 1], isOmni)).result;
    getRawTx.blockHeight = getBlock.height;
    getRawTx.txIndex = getBlock.tx.indexOf(txid);
    return res.status(200).send({
      error: null,
      message: 'Data obtained successfully.',
      result: getRawTx,
    });
  } catch (errT) {
    if (errT && errT.message) {
      return res.status(500).send({ error: errT.message, result: null });
    }
    return res.status(500).send({ error: 'Internal error.', result: null });
  }
};
